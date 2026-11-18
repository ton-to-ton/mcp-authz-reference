import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const VALID = {
  ISSUER: 'http://localhost:8080/realms/itsm-lab',
  RESOURCE_URL: 'http://localhost:3000/mcp',
  JWKS_URI: 'http://keycloak:8080/realms/itsm-lab/protocol/openid-connect/certs',
};

describe('loadConfig', () => {
  it('reads the three URLs and defaults the port to 3000', () => {
    const config = loadConfig(VALID);
    expect(config.issuer).toBe(VALID.ISSUER);
    expect(config.resource.href).toBe(VALID.RESOURCE_URL);
    expect(config.jwksUri.href).toBe(VALID.JWKS_URI);
    expect(config.port).toBe(3000);
  });

  it('reads PORT', () => {
    expect(loadConfig({ ...VALID, PORT: '4000' }).port).toBe(4000);
  });

  it('names the missing variable', () => {
    expect(() => loadConfig({})).toThrow(/ISSUER/);
    expect(() => loadConfig({ ...VALID, RESOURCE_URL: undefined })).toThrow(/RESOURCE_URL/);
    expect(() => loadConfig({ ...VALID, JWKS_URI: undefined })).toThrow(/JWKS_URI/);
  });

  it('names a malformed variable', () => {
    expect(() => loadConfig({ ...VALID, JWKS_URI: 'not a url' })).toThrow(/JWKS_URI/);
    expect(() => loadConfig({ ...VALID, PORT: 'abc' })).toThrow(/PORT/);
  });
});
