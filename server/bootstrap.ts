/** Excubitor injects configuration and Vault secrets before this entry runs. */
import { assertRequiredEnv } from './lib/env-bootstrap.ts';
import { install as installVestigium } from '@ludiars/vestigium';

installVestigium({
  serviceCode: 'ae',
  captureConsole: true,
  pinoTransport: false,
});

// Fail before importing modules that open databases or start network activity.
assertRequiredEnv(process.env);
await import('./index.ts');
