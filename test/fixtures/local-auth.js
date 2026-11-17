// Public deterministic credentials for isolated test servers only.
export const localAuth = { token: 'a'.repeat(64), installationId: 'b'.repeat(32) };
export const securePath = (pathname) => `/${localAuth.token}${pathname}`;
