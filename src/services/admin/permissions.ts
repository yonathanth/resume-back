// Roles and what they may do. Today there is one admin role with every
// permission; a narrower role (e.g. "SUPPORT" with users:read + users:write)
// is a new entry in ROLE_PERMISSIONS — routes already ask for a specific
// permission, so nothing else has to change.

export const ROLES = ["USER", "ADMIN"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "overview:read",
  "users:read",
  "users:write", // verify, suspend, reactivate, sessions, password reset, usage reset
  "users:delete",
  "entitlements:write",
  "billing:read",
  "billing:write", // Polar cancel/resume, sync and webhook retry
  "settings:write",
  "notifications:send",
  "audit:read",
  "ai:read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  USER: [],
  ADMIN: PERMISSIONS,
};

export function isAdminRole(role: string | null | undefined): boolean {
  return role === "ADMIN";
}

export function roleHasPermission(role: string | null | undefined, permission: Permission): boolean {
  if (!role || !(ROLES as readonly string[]).includes(role)) return false;
  return ROLE_PERMISSIONS[role as Role].includes(permission);
}

export function permissionsFor(role: string | null | undefined): Permission[] {
  if (!role || !(ROLES as readonly string[]).includes(role)) return [];
  return [...ROLE_PERMISSIONS[role as Role]];
}
