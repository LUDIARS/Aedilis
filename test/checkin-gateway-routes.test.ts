import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { b64urlEncode, type AttestationPayload } from '../server/checkin/attestation.ts';
import { hashGatewayToken } from '../server/checkin/gateway-token.ts';
import { openDb, upsertGateway } from '../server/db.ts';
import { makeCheckinRouter } from '../server/routes/checkin.ts';

const gatewayToken = 'gateway_route_test_token_12345678901234567890';

function buildGatewayApp(): { app: Hono; privateKey: KeyObject } {
  const pair = generateKeyPairSync('ed25519');
  const db = openDb(':memory:');
  upsertGateway(db, {
    lanId: 'kiosk-lan',
    facilityId: 'room-101',
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    tokenHash: hashGatewayToken(gatewayToken),
  });
  const app = new Hono();
  app.route('/api', makeCheckinRouter(db));
  return { app, privateKey: pair.privateKey };
}

function signedAttestation(privateKey: KeyObject): string {
  const payload: AttestationPayload = {
    sub: 'student-1', placeId: 'room-101', lanId: 'kiosk-lan', nonce: 'gateway-route-nonce',
    issuedAt: Date.now(), method: 'face', assurance: 'high',
  };
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload)));
  return `${body}.${b64urlEncode(cryptoSign(null, Buffer.from(body), privateKey))}`;
}

describe('gateway check-in routes', () => {
  it('requires a gateway token before accepting a kiosk attestation', async () => {
    const { app, privateKey } = buildGatewayApp();
    const response = await app.request('/api/checkin/gateway-verify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attestation: signedAttestation(privateKey) }),
    });
    expect(response.status).toBe(401);
  });

  it('accepts a registered gateway attestation and count-only event summary', async () => {
    const { app, privateKey } = buildGatewayApp();
    const headers = { authorization: `Bearer ${gatewayToken}`, 'content-type': 'application/json' };
    const verify = await app.request('/api/checkin/gateway-verify', {
      method: 'POST', headers, body: JSON.stringify({ attestation: signedAttestation(privateKey) }),
    });
    expect(verify.status).toBe(200);
    const summary = await app.request('/api/checkin/events-summary', {
      method: 'POST', headers, body: JSON.stringify({ counts: { face_verified: 4, retry: 1 } }),
    });
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({ ok: true });
  });
});
