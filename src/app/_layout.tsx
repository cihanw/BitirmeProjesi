// src/app/_layout.tsx
import { SplashScreen, Stack, usePathname, useRootNavigationState, useRouter, useSegments } from "expo-router";
import { HeroUINativeProvider } from 'heroui-native';
import { AppState, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import * as MediaLibrary from 'expo-media-library';
import '../../global.css';
import '@/src/i18n/index';
import { Uniwind } from "uniwind";
import { initMixpanel } from '@/src/mixpanel';
import { KeyboardProvider } from "react-native-keyboard-controller";
import { useAuthContext } from "../hooks/auth-hooks";
import { useEffect, useRef, useState } from "react";
import AuthProvider from "../providers/auth-provider";
import { isSupabaseConfigured } from "@/lib/supabase";
import { cancelLaunchSearchSync, ensureLaunchSearchSync, syncNewLibraryPhotos } from '@/src/lib/sync-service';

initMixpanel();
Uniwind.setTheme('tagged-light');

SplashScreen.preventAutoHideAsync();

const ALLOWED_PREFIXES = ["/home", "/photo-detail", "/photo-edit", "/albums", "/people", "/profile"];
const AUTH_PREFIXES = ["login", "register", "reset-password"];

function isAllowedPath(path: string) {
  return ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function RootLayoutNav() {
  const { session, profile, isLoading, isLoggedIn } = useAuthContext();
  const segments = useSegments();
  const pathname = usePathname();
  const router = useRouter();
  const rootNavigationState = useRootNavigationState();
  const [isNavigationReady, setIsNavigationReady] = useState(false);
  const hasBootstrappedNavigation = useRef(false);
  const startedLaunchSyncKey = useRef<string | null>(null);
  const appStateRef = useRef(AppState.currentState);

  useEffect(() => {
    if (isLoading || !rootNavigationState?.key) return;

    const currentPath = segments[0] || "";
    const inAuthGroup = AUTH_PREFIXES.includes(String(currentPath));
    const inOnboarding = currentPath === "onboarding";
    const inPasswordReset = currentPath === "reset-password";
    const isAtRoot = segments.length < 1;

    if (!hasBootstrappedNavigation.current) {
      hasBootstrappedNavigation.current = true;

      if (!isSupabaseConfigured) {
        if (!isAllowedPath(pathname)) {
          router.replace("/home");
        }
      } else if (!isLoggedIn) {
        if (!inAuthGroup && !isAtRoot) {
          router.replace("/");
        }
      } else if (inPasswordReset) {
        // Password recovery creates a temporary session; keep the user on the reset form.
      } else if (!profile?.onboarding_completed) {
        if (!inOnboarding) {
          router.replace("/onboarding");
        }
      } else if (pathname !== "/home") {
        router.replace("/home");
      }

      setIsNavigationReady(true);
      return;
    }

    if (!isSupabaseConfigured) {
      if (!isAllowedPath(pathname)) {
        router.replace("/home");
      }
    } else if (!isLoggedIn) {
      if (!inAuthGroup && !isAtRoot) {
        router.replace("/");
      }
    } else {
      if (inPasswordReset) {
        setIsNavigationReady(true);
        return;
      }

      if (!profile?.onboarding_completed) {
        if (!inOnboarding) {
          router.replace("/onboarding");
        }
      } else {
        if (isAtRoot || inAuthGroup || inOnboarding) {
          router.replace("/home");
        }
      }
    }

    setIsNavigationReady(true);
  }, [isLoading, isLoggedIn, pathname, profile?.onboarding_completed, rootNavigationState?.key, router, segments]);

  useEffect(() => {
    if (isNavigationReady && !isLoading && rootNavigationState?.key) {
      SplashScreen.hideAsync();
    }
  }, [isNavigationReady, isLoading, rootNavigationState?.key]);

  useEffect(() => {
    if (isLoading || !rootNavigationState?.key) return;
    if (isSupabaseConfigured && !isLoggedIn) {
      cancelLaunchSearchSync();
      startedLaunchSyncKey.current = null;
      return;
    }

    const syncKey = isSupabaseConfigured ? session?.user.id : 'local';
    if (!syncKey || startedLaunchSyncKey.current === syncKey) return;

    startedLaunchSyncKey.current = syncKey;

    ensureLaunchSearchSync(syncKey)
      .then((summary) => {
        console.log('Launch search sync summary:', summary);
      })
      .catch((error) => {
        console.warn('Launch search sync failed:', error);
      });
  }, [isLoading, isLoggedIn, rootNavigationState?.key, session?.user.id]);

  useEffect(() => {
    if (isLoading || !rootNavigationState?.key) return;
    if (isSupabaseConfigured && !isLoggedIn) return;

    const syncKey = isSupabaseConfigured ? session?.user.id : 'local';
    if (!syncKey) return;

    let syncInFlight: Promise<void> | null = null;

    const runIncrementalSync = (insertedAssets?: MediaLibrary.Asset[]) => {
      if (syncInFlight) return;

      syncInFlight = syncNewLibraryPhotos(syncKey, insertedAssets)
        .then((summary) => {
          if (summary.queued > 0 || summary.failed > 0) {
            console.log('New photo sync summary:', summary);
          }
        })
        .catch((error) => {
          console.warn('New photo sync failed:', error);
        })
        .finally(() => {
          syncInFlight = null;
        });
    };

    const appStateSubscription = AppState.addEventListener('change', (nextAppState) => {
      const wasBackgrounded = /inactive|background/.test(appStateRef.current);
      appStateRef.current = nextAppState;

      if (wasBackgrounded && nextAppState === 'active') {
        runIncrementalSync();
      }
    });

    const mediaLibrarySubscription = MediaLibrary.addListener((event) => {
      runIncrementalSync(event.insertedAssets);
    });

    return () => {
      appStateSubscription.remove();
      mediaLibrarySubscription.remove();
    };
  }, [isLoading, isLoggedIn, rootNavigationState?.key, session?.user.id]);

  return <Stack screenOptions={{ headerShown: false }} />;
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={styles.root}>
      <AuthProvider>
        <KeyboardProvider>
          <HeroUINativeProvider>
            <RootLayoutNav />
          </HeroUINativeProvider>
        </KeyboardProvider>
      </AuthProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
