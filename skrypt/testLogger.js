// skrypt/testLogger.js
import { createTaskLogger } from './loggerZadan.js';

const monitorId = 'test-monitor';
const zadanieId = 'test-zadanie';

const logger = await createTaskLogger({ monitorId, zadanieId });

logger.info('test_log', { foo: 'bar' });
logger.warn('test_warn', { bar: 'baz' });
logger.error('test_error', { baz: 123 });

logger.close();

console.log('Logger test finished');
