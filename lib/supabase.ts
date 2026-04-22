import { AppState, Platform } from 'react-native';
import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);
const SUPABASE_AUTH_STORAGE_KEY = 'sb-auth-token';

export const supabaseConfigError = new Error(
    'Supabase env vars are missing. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY.'
);

export function isInvalidRefreshTokenError(error: unknown): boolean {
    if (!error) return false;
    const message =
        error instanceof Error
            ? error.message
            : typeof error === 'object' && error !== null && 'message' in error
                ? String(error.message)
                : String(error);

    return message.toLowerCase().includes('invalid refresh token');
}

export async function clearSupabaseAuthStorage() {
    if (Platform.OS === 'web') return;

    await AsyncStorage.multiRemove([
        SUPABASE_AUTH_STORAGE_KEY,
        `${SUPABASE_AUTH_STORAGE_KEY}-code-verifier`,
        `${SUPABASE_AUTH_STORAGE_KEY}-user`,
    ]);
}

function createFallbackSupabaseClient() {
    const queryBuilder = {
        select: () => ({
            eq: () => ({
                single: async () => ({ data: null, error: supabaseConfigError }),
            }),
        }),
        insert: async () => ({ data: null, error: supabaseConfigError }),
        update: () => ({
            eq: async () => ({ data: null, error: supabaseConfigError }),
        }),
        upsert: async () => ({ data: null, error: supabaseConfigError }),
    };

    return {
        auth: {
            getSession: async () => ({ data: { session: null }, error: supabaseConfigError }),
            onAuthStateChange: () => ({
                data: { subscription: { unsubscribe: () => undefined } },
            }),
            resetPasswordForEmail: async () => ({ data: null, error: supabaseConfigError }),
            signInWithPassword: async () => ({ data: { user: null, session: null }, error: supabaseConfigError }),
            signUp: async () => ({ data: { user: null, session: null }, error: supabaseConfigError }),
            signOut: async () => ({ error: supabaseConfigError }),
            startAutoRefresh: () => undefined,
            stopAutoRefresh: () => undefined,
        },
        from: () => queryBuilder,
    };
}

export const supabase = isSupabaseConfigured
    ? createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
            ...(Platform.OS !== 'web' ? { storage: AsyncStorage } : {}),
            autoRefreshToken: true,
            persistSession: true,
            detectSessionInUrl: false,
            storageKey: 'sb-auth-token',
            flowType: 'pkce',
        },
    })
    : (createFallbackSupabaseClient() as any);

if (Platform.OS !== 'web') {
    AppState.addEventListener('change', (state) => {
        if (state === 'active') {
            supabase.auth.startAutoRefresh();
        } else {
            supabase.auth.stopAutoRefresh();
        }
    });
}
