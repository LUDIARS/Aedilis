type Environment = Readonly<Record<string, string | undefined>>;

const required = [
  'CERNERE_BASE_URL',
  'AEDILIS_PUBLIC_URL',
  'CERNERE_PROJECT_CLIENT_ID',
  'CERNERE_PROJECT_CLIENT_SECRET',
];

export default {
  post: (_result: void, env: Environment): boolean =>
    required.every((key) => Boolean(env[key]?.trim())),
  postThrow: (error: unknown, env: Environment): boolean => {
    const missing = required.filter((key) => !env[key]?.trim());
    return missing.length > 0 && error instanceof Error &&
      error.message === `[bootstrap] Missing required environment: ${missing.join(', ')}`;
  },
};
