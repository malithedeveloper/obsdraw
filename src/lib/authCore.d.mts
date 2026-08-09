export const AUTH_COOKIE_NAME: string;
export const AUTH_MAX_AGE_SECONDS: number;
export function sanitizeDisplayName(value: unknown): string;
export function verifyAccessKey(candidate: unknown): boolean;
export function verifyViewKey(candidate: unknown): boolean;
export function createAuthToken(name: unknown): string | null;
export function verifyAuthToken(token: unknown): { name: string; iat: number } | null;
export function createSocketToken(role: "editor" | "viewer", name: unknown): string | null;
export function verifySocketToken(token: unknown): { role: "editor" | "viewer"; name: string; iat: number } | null;
