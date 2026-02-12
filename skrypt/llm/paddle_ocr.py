#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os
import sys

# cisza + stabilność
os.environ.setdefault("DISABLE_MODEL_SOURCE_CHECK", "True")
os.environ.setdefault("GLOG_minloglevel", "3")
os.environ.setdefault("FLAGS_minloglevel", "3")
os.environ.setdefault("PADDLE_LOG_LEVEL", "3")

# Workaround na crashe oneDNN/PIR (można nadpisać env)
os.environ.setdefault("FLAGS_use_mkldnn", "0")
os.environ.setdefault("FLAGS_enable_pir_api", "0")

import json
import base64
import argparse
import io
import warnings
import logging
import traceback
import types
import numbers
import tempfile
from pathlib import Path

warnings.filterwarnings("ignore", category=DeprecationWarning)
warnings.filterwarnings("ignore")
logging.getLogger("ppocr").setLevel(logging.ERROR)
logging.getLogger("paddle").setLevel(logging.ERROR)

try:
    from PIL import Image
except ImportError as e:
    sys.stdout.write(json.dumps({"ok": False, "error": f"ImportError: {str(e)}"}, ensure_ascii=False))
    sys.exit(1)


def _install_langchain_docstore_shim() -> None:
    # Safety-net: u Ciebie już to naprawione w venv, ale zostawiamy.
    try:
        from langchain.docstore.document import Document  # noqa: F401
        return
    except Exception:
        pass

    Document = None
    try:
        from langchain_core.documents import Document as CoreDocument  # type: ignore
        Document = CoreDocument
    except Exception:
        Document = None

    if Document is None:
        try:
            from dataclasses import dataclass, field
            from typing import Any, Dict

            @dataclass
            class Document:  # type: ignore
                page_content: str
                metadata: Dict[str, Any] = field(default_factory=dict)
        except Exception:
            return

    if "langchain" not in sys.modules:
        m = types.ModuleType("langchain")
        m.__path__ = []
        sys.modules["langchain"] = m
    else:
        try:
            getattr(sys.modules["langchain"], "__path__")
        except Exception:
            sys.modules["langchain"].__path__ = []

    if "langchain.docstore" not in sys.modules:
        m = types.ModuleType("langchain.docstore")
        m.__path__ = []
        sys.modules["langchain.docstore"] = m

    mod_document = types.ModuleType("langchain.docstore.document")
    mod_document.Document = Document
    sys.modules["langchain.docstore.document"] = mod_document


def read_stdin_base64():
    data = sys.stdin.buffer.read()
    if not data:
        return None

    b64_str = data.decode("utf-8", errors="ignore").strip()
    if "base64," in b64_str:
        _, b64_str = b64_str.split("base64,", 1)

    b64_str = "".join(b64_str.split())
    if not b64_str:
        return None

    try:
        return base64.b64decode(b64_str)
    except Exception as e:
        raise ValueError(f"Błąd dekodowania Base64: {str(e)}")


def _box_bounds(box):
    # box może być [xmin, ymin, xmax, ymax]
    if isinstance(box, (list, tuple)) and len(box) == 4 and all(isinstance(v, numbers.Real) for v in box):
        xmin, ymin, xmax, ymax = box
        return float(xmin), float(ymin), float(xmax), float(ymax)
    return None


def _poly_bounds(poly):
    # poly może być np. array([[x,y],...]) albo list punktów
    try:
        pts = list(poly)
        if not pts:
            return None
        xs = [float(p[0]) for p in pts]
        ys = [float(p[1]) for p in pts]
        return float(min(xs)), float(min(ys)), float(max(xs)), float(max(ys))
    except Exception:
        return None


def build_text_from_paddlex_page(page: dict):
    """
    Dla PaddleOCR 3.x (PaddleX pipeline):
      - tekst: page['rec_texts'] (list[str])
      - score: page['rec_scores'] (list[float])
      - geometria: page['rec_boxes'] lub page['rec_polys']
    Składamy tokeny w linie po y, sortujemy po y potem x.
    """
    rec_texts = page.get("rec_texts")
    rec_scores = page.get("rec_scores")
    rec_boxes = page.get("rec_boxes")
    rec_polys = page.get("rec_polys")

    if not isinstance(rec_texts, list) or not rec_texts:
        return "", 0.0

    tokens = []
    heights = []

    for i, t in enumerate(rec_texts):
        if not isinstance(t, str) or not t.strip():
            continue

        sc = None
        if isinstance(rec_scores, list) and i < len(rec_scores) and isinstance(rec_scores[i], numbers.Real):
            sc = float(rec_scores[i])

        b = None
        if isinstance(rec_boxes, list) and i < len(rec_boxes):
            b = _box_bounds(rec_boxes[i])
        if b is None and isinstance(rec_polys, list) and i < len(rec_polys):
            b = _poly_bounds(rec_polys[i])

        if b is None:
            # fallback: brak geometrii -> bez grupowania
            tokens.append((0.0, float(i), float(i), t, sc))
            continue

        x0, y0, x1, y1 = b
        cx = (x0 + x1) / 2.0
        cy = (y0 + y1) / 2.0
        h = max(0.0, y1 - y0)
        heights.append(h)
        tokens.append((cy, x0, x1, t, sc))

    if not tokens:
        return "", 0.0

    # sortowanie po y, potem x
    tokens.sort(key=lambda x: (x[0], x[1]))

    # próg grupowania linii na bazie "typowej" wysokości
    median_h = 20.0
    if heights:
        hs = sorted(heights)
        median_h = hs[len(hs) // 2] or 20.0
    y_thr = max(10.0, median_h * 0.6)

    lines = []
    cur_line = []
    cur_y = None

    for cy, x0, x1, t, sc in tokens:
        if cur_y is None:
            cur_y = cy
            cur_line = [(x0, x1, t, sc)]
            continue
        if abs(cy - cur_y) <= y_thr:
            cur_line.append((x0, x1, t, sc))
        else:
            cur_line.sort(key=lambda x: x[0])
            lines.append(cur_line)
            cur_y = cy
            cur_line = [(x0, x1, t, sc)]

    if cur_line:
        cur_line.sort(key=lambda x: x[0])
        lines.append(cur_line)

    # Jeżeli w jednej linii są różne kolumny / tabele (duże przerwy w X), rozbijamy na pod-linie.
    # To jest uniwersalne i poprawia kolejność czytania, bez heurystyk e-commerce.
    gap_thr = max(80.0, median_h * 3.0)
    split_lines = []
    for line in lines:
        seg = []
        prev_x1 = None
        for x0, x1, t, sc in line:
            if prev_x1 is not None and (x0 - prev_x1) > gap_thr and seg:
                split_lines.append(seg)
                seg = []
            seg.append((x0, x1, t, sc))
            prev_x1 = x1
        if seg:
            split_lines.append(seg)
    lines = split_lines

    # sklej linie
    out_lines = []
    all_scores = []
    for line in lines:
        out_lines.append(" ".join([t for (_, _, t, _) in line]).strip())
        for (_, _, _, sc) in line:
            if isinstance(sc, numbers.Real):
                all_scores.append(float(sc))

    text_out = "\n".join([l for l in out_lines if l]).strip()
    avg_conf = (sum(all_scores) / len(all_scores)) if all_scores else 0.0
    return text_out, avg_conf


def run_ocr(img_bytes: bytes, lang: str, use_textline_orientation: bool):
    try:
        img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    except Exception as e:
        raise ValueError(f"Nieprawidłowy obraz: {str(e)}")

    _install_langchain_docstore_shim()

    from paddleocr import PaddleOCR

    # Użyj nowszego parametru (w 3.x use_angle_cls jest deprecated)
    ocr_engine = PaddleOCR(
        lang=lang,
        use_textline_orientation=use_textline_orientation,
    )

    def _engine_run_on_path(img_path: str):
        if hasattr(ocr_engine, "predict"):
            return ocr_engine.predict(img_path)
        return ocr_engine.ocr(img_path)

    def _parse_paddlex_result(raw_result):
        if not raw_result or raw_result == [None]:
            return "", 0.0

        # PaddleX pipeline: lista dictów
        if isinstance(raw_result, list) and raw_result and isinstance(raw_result[0], dict):
            texts = []
            confs = []
            for page in raw_result:
                t, c = build_text_from_paddlex_page(page)
                if t:
                    texts.append(t)
                if isinstance(c, numbers.Real) and c > 0:
                    confs.append(float(c))

            text_out = "\n".join(texts).strip()
            avg_conf = (sum(confs) / len(confs)) if confs else 0.0
            return text_out, avg_conf

        # Fallback (gdyby format był inny)
        return "", 0.0

    # --- SLICING (opcjonalne, dla bardzo wysokich screenshotów) ---
    # Domyślnie off (uniwersalność + szybkość); włącz przez env OCR_SLICE_ENABLE=true
    slice_enable = (os.environ.get("OCR_SLICE_ENABLE", "false").lower() == "true")
    slice_max_h = int(os.environ.get("OCR_SLICE_MAX_H", "1800") or "1800")
    slice_overlap = int(os.environ.get("OCR_SLICE_OVERLAP", "220") or "220")
    slice_min_h = int(os.environ.get("OCR_SLICE_MIN_H", "2200") or "2200")

    def _iter_slices(im: Image.Image):
        w, h = im.size
        if not slice_enable or h <= max(slice_min_h, slice_max_h) or slice_max_h <= 0:
            yield (0, h, im)
            return
        step = max(1, slice_max_h - max(0, slice_overlap))
        y0 = 0
        while y0 < h:
            y1 = min(h, y0 + slice_max_h)
            # zapewnij, że ostatni slice obejmuje dół
            if y1 == h and y1 - y0 < slice_max_h and h > slice_max_h:
                y0 = max(0, h - slice_max_h)
                y1 = h
            crop = im.crop((0, y0, w, y1))
            yield (y0, y1, crop)
            if y1 == h:
                break
            y0 += step

    texts_all = []
    confs_all = []

    # Uruchom OCR na (ew.) slice'ach
    for (y0, y1, crop) in _iter_slices(img):
        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(prefix="ocr_", suffix=".png", delete=False) as f:
                tmp_path = f.name
            crop.save(tmp_path, format="PNG", optimize=True)

            raw_result = _engine_run_on_path(tmp_path)
            t, c = _parse_paddlex_result(raw_result)
            if t:
                texts_all.append(t)
            if isinstance(c, numbers.Real) and c > 0:
                confs_all.append(float(c))
        finally:
            try:
                if tmp_path and Path(tmp_path).exists():
                    os.remove(tmp_path)
            except Exception:
                pass

    text_out = "\n".join([t for t in texts_all if t]).strip()
    avg_conf = (sum(confs_all) / len(confs_all)) if confs_all else 0.0
    return text_out, avg_conf


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--lang", default="pl")
    parser.add_argument("--angle", action="store_true")  # zachowane dla kompatybilności CLI
    args = parser.parse_args()

    try:
        img_bytes = read_stdin_base64()
        if img_bytes is None:
            print(json.dumps({"ok": True, "text": "", "confidence": 0.0}, ensure_ascii=False))
            sys.exit(0)

        # mapujemy --angle na use_textline_orientation (u Ciebie i tak zwykle false)
        text, conf = run_ocr(img_bytes, args.lang, use_textline_orientation=bool(args.angle))
        print(json.dumps({"ok": True, "text": text, "confidence": conf}, ensure_ascii=False))

    except Exception as e:
        tb = traceback.format_exc()
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {str(e)}\n{tb[-1500:]}"}, ensure_ascii=False))
        sys.exit(1)
