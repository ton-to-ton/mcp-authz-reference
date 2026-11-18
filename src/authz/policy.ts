export type ToolName = 'search_tickets' | 'get_ticket' | 'add_comment' | 'close_ticket';
export type Tier = 'read' | 'write' | 'close';
export type Grant = { readonly scopes: readonly string[]; readonly roles: readonly string[] };

export const TOOL_TIER: Readonly<Record<ToolName, Tier>> = {
  search_tickets: 'read',
  get_ticket: 'read',
  add_comment: 'write',
  close_ticket: 'close',
};

export const TIER_SCOPE: Readonly<Record<Tier, string>> = {
  read: 'itsm:read',
  write: 'itsm:write',
  close: 'itsm:close',
};

export const TIER_ROLES: Readonly<Record<Tier, readonly string[]>> = {
  read: ['itsm-viewer', 'itsm-operator'],
  write: ['itsm-operator'],
  close: ['itsm-operator'],
};

// The scope says what the client may do on the user's behalf; the role says what the user may
// do at all. A tool needs both, so a viewer cannot write even if a client was granted the scope.
export function isAllowed(tool: ToolName, grant: Grant): boolean {
  const tier = TOOL_TIER[tool];
  return (
    grant.scopes.includes(TIER_SCOPE[tier]) &&
    TIER_ROLES[tier].some((role) => grant.roles.includes(role))
  );
}

export function allowedTools(grant: Grant): ToolName[] {
  // Object.keys loses the key type; TOOL_TIER is the single source of the ToolName list.
  return (Object.keys(TOOL_TIER) as ToolName[]).filter((tool) => isAllowed(tool, grant));
}
