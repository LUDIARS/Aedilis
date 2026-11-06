export default {
  post: (_result: unknown, sessionId: string, operation: { action: string; resource: string; body: string }, risk: string): boolean =>
    sessionId.length >= 32 && !!operation.action && !!operation.resource && typeof operation.body === 'string' && ['read', 'sensitive_read', 'important'].includes(risk),
};
