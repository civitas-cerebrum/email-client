import debug from 'debug';

/**
 * Creates a namespaced debug logger for the email-client package.
 * Enable with `DEBUG=email-client:*` environment variable.
 */
export function createLogger(namespace: string): debug.Debugger {
    return debug(`email-client:${namespace}`);
}
