import { describe, expect, it } from 'vitest';
import { allowedTools, isAllowed } from '../../src/authz/policy.js';

const viewer = { scopes: ['itsm:read', 'itsm:write', 'itsm:close'], roles: ['itsm-viewer'] };
const operatorReadOnly = { scopes: ['itsm:read'], roles: ['itsm-operator'] };

describe('allowedTools', () => {
  it('viewer gets read tools only even if write/close scopes are granted', () => {
    expect(allowedTools(viewer)).toEqual(['search_tickets', 'get_ticket']);
  });
  it('operator with read scope only cannot close', () => {
    expect(isAllowed('close_ticket', operatorReadOnly)).toBe(false);
    expect(allowedTools(operatorReadOnly)).toEqual(['search_tickets', 'get_ticket']);
  });
  it('operator with all scopes gets every tool', () => {
    expect(
      allowedTools({
        scopes: ['itsm:read', 'itsm:write', 'itsm:close'],
        roles: ['itsm-operator'],
      }),
    ).toEqual(['search_tickets', 'get_ticket', 'add_comment', 'close_ticket']);
  });
  it('operator with read+write gets three tools, not close', () => {
    expect(allowedTools({ scopes: ['itsm:read', 'itsm:write'], roles: ['itsm-operator'] })).toEqual(
      ['search_tickets', 'get_ticket', 'add_comment'],
    );
  });
  it('close scope alone gives no read tools', () => {
    expect(allowedTools({ scopes: ['itsm:close'], roles: ['itsm-operator'] })).toEqual([
      'close_ticket',
    ]);
    expect(allowedTools({ scopes: ['itsm:close'], roles: ['itsm-viewer'] })).toEqual([]);
  });
  it('empty grant yields no tools', () => {
    expect(allowedTools({ scopes: [], roles: [] })).toEqual([]);
  });
  it('scope for another resource does not count', () => {
    expect(allowedTools({ scopes: ['other:read'], roles: ['itsm-operator'] })).toEqual([]);
  });
});
