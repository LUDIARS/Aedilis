import { describe, expect, it } from 'vitest';
import { assertRequiredEnv } from '../server/lib/env-bootstrap.ts';
import contract from '../contracts/startup-env.contract.ts';

const complete = {
  CERNERE_BASE_URL: 'https://cernere.example',
  AEDILIS_PUBLIC_URL: 'https://aedilis.example',
  CERNERE_PROJECT_CLIENT_ID: 'test-client',
  CERNERE_PROJECT_CLIENT_SECRET: 'test-secret',
};

describe('Excubitor-injected startup environment', () => {
  it('accepts all required keys without an admin list and leaves input untouched', () => {
    const env = Object.freeze({ ...complete });
    expect(assertRequiredEnv(env)).toBeUndefined();
    expect(contract.post(undefined, env)).toBe(true);
    expect(env).toEqual(complete);
  });

  for (const key of Object.keys(complete)) {
    it.each([undefined, '', ' \t\n'])(`rejects missing or blank ${key}: %s`, (value) => {
      const env = { ...complete, [key]: value };
      const message = `[bootstrap] Missing required environment: ${key}`;
      expect(() => assertRequiredEnv(env)).toThrow(message);
      expect(contract.postThrow(new Error(message), env)).toBe(true);
    });
  }

  it('lists every missing name and never includes supplied values', () => {
    expect(() => assertRequiredEnv({ CERNERE_PROJECT_CLIENT_SECRET: 'private-test-value' }))
      .toThrow('[bootstrap] Missing required environment: CERNERE_BASE_URL, AEDILIS_PUBLIC_URL, CERNERE_PROJECT_CLIENT_ID');
  });

  it('does not accept legacy identity credentials in place of application settings', () => {
    expect(() => assertRequiredEnv({ INFISICAL_CLIENT_ID: 'legacy', INFISICAL_CLIENT_SECRET: 'legacy' }))
      .toThrow('Missing required environment:');
  });

  it('rejects incorrect success and failure in the acceptance predicate', () => {
    expect(contract.post(undefined, {})).toBe(false);
    expect(contract.postThrow(new Error('unexpected failure'), complete)).toBe(false);
    expect(contract.postThrow(new Error('private-test-value'), {})).toBe(false);
  });
});
