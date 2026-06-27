import { Amplify } from 'aws-amplify';
import {
  fetchAuthSession,
  getCurrentUser,
  signInWithRedirect,
  signOut as amplifySignOut,
} from 'aws-amplify/auth';
import type { AuthUser } from './types';

type Env = Record<string, string | undefined>;

const env = (import.meta as { env: Env }).env;

const COGNITO_USER_POOL_ID = env.VITE_COGNITO_USER_POOL_ID;
const COGNITO_USER_POOL_CLIENT_ID = env.VITE_COGNITO_USER_POOL_CLIENT_ID;
const COGNITO_REGION = env.VITE_COGNITO_REGION;
const COGNITO_DOMAIN = env.VITE_COGNITO_DOMAIN;
const OAUTH_SIGN_IN = env.VITE_COGNITO_REDIRECT_SIGN_IN || window.location.origin;
const OAUTH_SIGN_OUT = env.VITE_COGNITO_REDIRECT_SIGN_OUT || window.location.origin;
const OAUTH_SCOPES = (env.VITE_COGNITO_OAUTH_SCOPES || 'openid email profile')
  .split(',')
  .map((scope) => scope.trim())
  .filter(Boolean);

let initialized = false;
let tokenCache: string | null = null;
let tokenExpiresAt = 0;

function cognitoConfigured() {
  return Boolean(COGNITO_USER_POOL_ID && COGNITO_USER_POOL_CLIENT_ID && COGNITO_REGION && COGNITO_DOMAIN);
}

export async function initializeAuth() {
  if (initialized) {
    return;
  }
  initialized = true;

  if (!cognitoConfigured()) {
    return;
  }

  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: COGNITO_USER_POOL_ID,
        userPoolClientId: COGNITO_USER_POOL_CLIENT_ID,
        region: COGNITO_REGION,
        loginWith: {
          oauth: {
            domain: COGNITO_DOMAIN,
            scopes: OAUTH_SCOPES,
            redirectSignIn: [OAUTH_SIGN_IN],
            redirectSignOut: [OAUTH_SIGN_OUT],
            responseType: 'code',
            providers: ['COGNITO'],
          },
        },
      },
    },
  });
}

export async function signIn() {
  await initializeAuth();
  if (!cognitoConfigured()) {
    throw new Error('Cognito environment variables are not configured.');
  }

  await signInWithRedirect({});
}

export async function signOut() {
  await initializeAuth();
  if (!cognitoConfigured()) {
    tokenCache = null;
    tokenExpiresAt = 0;
    return;
  }
  await amplifySignOut();
  tokenCache = null;
  tokenExpiresAt = 0;
}

export async function getCurrentUserProfile(): Promise<AuthUser | null> {
  await initializeAuth();
  if (!cognitoConfigured()) {
    const fallbackToken = localStorage.getItem('id_token');
    if (!fallbackToken) {
      return null;
    }
    return {
      username: 'dev-user',
      userId: 'dev-user',
      email: 'dev-user@example.com',
      displayName: 'Developer',
    };
  }

  try {
    const user = await getCurrentUser();
    const session = await fetchAuthSession();
    const payload = session.tokens?.idToken?.payload || {};
    return {
      username: user.username,
      userId: user.userId || user.username,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      displayName:
        typeof payload.name === 'string'
          ? payload.name
          : typeof payload.preferred_username === 'string'
            ? payload.preferred_username
            : user.username,
    };
  } catch {
    return null;
  }
}

export async function getAuthToken(): Promise<string | null> {
  await initializeAuth();
  const now = Date.now();
  if (tokenCache && now < tokenExpiresAt) {
    return tokenCache;
  }

  if (!cognitoConfigured()) {
    const token = localStorage.getItem('id_token');
    return token || null;
  }

  try {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString() || session.tokens?.accessToken?.toString() || null;
    if (token) {
      tokenCache = token;
      tokenExpiresAt = now + 50 * 60 * 1000;
      localStorage.setItem('id_token', token);
      return token;
    }
  } catch {
    tokenCache = null;
    tokenExpiresAt = 0;
  }

  return null;
}

