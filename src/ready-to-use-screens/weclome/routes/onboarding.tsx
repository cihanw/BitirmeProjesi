import AntDesign from "@expo/vector-icons/AntDesign";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { Button } from "heroui-native";
import { ChevronDown } from "lucide-react-native";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, Pressable, Text, useWindowDimensions, View } from "react-native";
import { FlatList, Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import Carousel from "../components/carousel";
import { OnboardingSlide } from "../components/lib/types";
import { trackEvent } from '@/src/mixpanel';
import { supabase } from "@/lib/supabase";
import * as AppleAuthentication from 'expo-apple-authentication';
import type { SignInWithIdTokenCredentials } from '@supabase/supabase-js';

// superlist-onboarding-flow-animation 🔽


// Distance in pixels to translate carousel upward when fully expanded
// Reveals sign-in buttons below carousel
const TOP_CAROUSEL_OFFSET = 230;
// Minimum swipe distance (in pixels) to trigger expand/collapse transition
// Prevents accidental toggles from small finger movements
const SWIPE_UP_THRESHOLD = 20;

export const Onboarding = () => {
  const [currentSlideIndex, setCurrentSlideIndex] = useState<number>(0);
  const isAppleSignInSupported = Platform.OS === "ios";
  const { t } = useTranslation();

  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();

  const horizontalListRef = useRef<FlatList<OnboardingSlide>>(null);

  // Continuous slide index (0.0, 0.5, 1.0, 1.5...) derived from scrollOffsetX / screenWidth
  // Enables smooth pagination width interpolation between discrete slide indices
  const animatedSlideIndex = useSharedValue(0);
  // Horizontal scroll offset in pixels, drives slide card animations (rotate/translateY)
  // Updated via scrollHandler on every scroll event (throttled to 16ms)
  const scrollOffsetX = useSharedValue(0);
  // Prevents auto-advance and progress animations during user interaction
  // Set to true on drag start, false on drag end
  const isDragging = useSharedValue(false);
  // Vertical translation for swipe-up gesture: 0 = collapsed, -TOP_CAROUSEL_OFFSET = expanded
  // Negative values move carousel upward, revealing content below
  const translateY = useSharedValue(0);
  // Stores translateY value at gesture start, used to calculate relative movement
  // Critical for pan gesture: accumulates translation from gesture start, not absolute position
  const gestureStartY = useSharedValue(0);

  const SLIDES: OnboardingSlide[] = useMemo(() => [
    {
      bgColor: "#1A8E3C",
      duration: 3000,
      title: t("welcome.sliderTitles.first"),
      imagePath: require("@/assets/real assets/startScreen1.png")
    },
    {
      bgColor: "#D4D0CB",
      duration: 3000,
      title: t("welcome.sliderTitles.second"),
      imagePath: require("@/assets/real assets/startScreen2.png")
    },
  ], [t]);

  // Scroll handler: updates shared values for scroll-driven animations
  // Runs on UI thread (worklet), enabling 60fps animations without JS bridge overhead
  const scrollHandler = useAnimatedScrollHandler({
    onBeginDrag: () => {
      // Disable auto-advance when user starts dragging
      isDragging.set(true);
    },
    onScroll: (event) => {
      const offsetX = event.contentOffset.x;
      // Update scroll position for slide card animations (rotate/translateY)
      scrollOffsetX.set(offsetX);
      // Calculate continuous slide index for smooth pagination width interpolation
      // Example: offsetX = 150px, screenWidth = 375px → animatedSlideIndex = 0.4
      animatedSlideIndex.set(offsetX / screenWidth);
    },
    onEndDrag: () => {
      // Re-enable auto-advance and resume progress animations
      isDragging.set(false);
    },
  });

  const handleScrollToIndex = useCallback((index: number) => {
    const itemCount = SLIDES.length + 1;
    const nextIndex = index >= itemCount ? 0 : Math.max(index, 0);

    horizontalListRef.current?.scrollToIndex({
      index: nextIndex,
      animated: true,
    });
  }, [SLIDES.length]);

  // Single tap gesture: advances to next slide when carousel is collapsed
  // maxDuration: 250ms ensures quick taps register, longer presses ignored
  const singleTap = Gesture.Tap()
    .maxDuration(250)
    .onStart(() => {
      // Only advance if carousel is fully collapsed (translateY >= 0)
      if (translateY.get() < 0) return;
      scheduleOnRN(handleScrollToIndex, currentSlideIndex + 1);
      isDragging.set(false);
    });

  // Pan gesture: handles vertical swipe-up/down to expand/collapse carousel
  // Uses damping factor (÷4) for smoother, more controlled feel
  const panGesture = Gesture.Pan()
    .onBegin(() => {
      isDragging.set(true);
      // Store starting position to calculate relative movement
      // Critical: gestureStartY captures translateY at gesture start, not absolute 0
      gestureStartY.set(translateY.get());
    })
    .onUpdate((e) => {
      // Prevent overscroll: block upward swipe when already at max expansion
      if (translateY.get() <= -TOP_CAROUSEL_OFFSET && e.translationY < 0) {
        return;
      }

      // Calculate new position: start position + gesture delta with damping
      // Damping factor (÷4): reduces sensitivity, creates smoother drag feel
      // e.translationY: positive = swipe down, negative = swipe up
      const proposed = gestureStartY.get() + e.translationY / 4;
      // Clamp between bounds: 0 (collapsed) to -TOP_CAROUSEL_OFFSET (expanded)
      const clamped = Math.min(0, Math.max(proposed, -TOP_CAROUSEL_OFFSET));
      translateY.set(clamped);
    })
    .onEnd((e) => {
      const currentY = translateY.get();

      // Determine if carousel is currently expanded (negative translateY)
      const isExpanded = currentY < 0;

      // Check if user swiped up enough to trigger transition
      // Compares absolute values: if moved up by threshold, expand
      const isTopThresholdReached =
        Math.abs(gestureStartY.get()) - Math.abs(currentY) > SWIPE_UP_THRESHOLD;

      // Check if user swiped down enough to trigger collapse
      const isBottomThresholdReached =
        Math.abs(currentY) - Math.abs(gestureStartY.get()) > SWIPE_UP_THRESHOLD;

      // Determine target position based on swipe direction and threshold
      // If swiped up past threshold: expand (go to 0 or stay at -TOP_CAROUSEL_OFFSET)
      const expandedPositionMap = isTopThresholdReached ? 0 : -TOP_CAROUSEL_OFFSET;
      // If swiped down past threshold: collapse (go to -TOP_CAROUSEL_OFFSET or stay at 0)
      const collapsedPositionMap = isBottomThresholdReached ? -TOP_CAROUSEL_OFFSET : 0;

      const target = isExpanded ? expandedPositionMap : collapsedPositionMap;

      // Animate to target with spring physics for natural feel
      translateY.set(
        withSpring(target, {}, (finished) => {
          // Re-enable interactions only when fully collapsed
          if (finished && target === 0) {
            isDragging.set(false);
          }
        })
      );
    });

  // Fade in sign-in buttons block as carousel expands upward
  // Input: translateY from 0 (collapsed) to -TOP_CAROUSEL_OFFSET (expanded)
  // Output: opacity from 0 (hidden) to 1 (visible)
  const rButtonsBlockStyle = useAnimatedStyle(() => {
    return {
      opacity: interpolate(
        translateY.get(),
        [0, -TOP_CAROUSEL_OFFSET],
        [0, 1],
        Extrapolation.CLAMP
      ),
    };
  });

  // "Sign Up / Sign In" button: slides up 40px as carousel expands
  // Creates staggered reveal effect with "Continue with email" button
  const rSignUpStyle = useAnimatedStyle(() => {
    return {
      transform: [
        {
          translateY: interpolate(
            translateY.get(),
            [0, -TOP_CAROUSEL_OFFSET],
            [0, -40],
            Extrapolation.CLAMP
          ),
        },
      ],
    };
  });

  const rContinueWithEmailStyle = useAnimatedStyle(() => {
    return {
      transform: [
        {
          translateY: interpolate(
            translateY.get(),
            [0, -TOP_CAROUSEL_OFFSET],
            [40, 0],
            Extrapolation.CLAMP
          ),
        },
      ],
    };
  });

  const expandButtons = () => {
    if (translateY.get() <= -TOP_CAROUSEL_OFFSET + 1) {
      trackEvent('onboarding_email_sign_in');
      router.replace("/login");
      return;
    }

    isDragging.set(false);
    translateY.set(
      withSpring(-TOP_CAROUSEL_OFFSET, {}, () => {
      })
    );
  };

  const rGradientStyle = useAnimatedStyle(() => {
    return {
      opacity: interpolate(
        translateY.get(),
        [0, -TOP_CAROUSEL_OFFSET],
        [0, 1],
        Extrapolation.CLAMP
      ),
    };
  });

  // Collapse carousel when user taps chevron down button
  // Smoothly animates translateY back to 0 (collapsed position)
  const slideBottomHandler = () => {
    isDragging.set(false);
    translateY.set(
      withTiming(0, {
        duration: 300,
      })
    );
  };

  const appleSignInHandler = async () => {
    if (!isAppleSignInSupported) return;

    trackEvent('onboarding_apple_sign_in');

    try {
      const appleAuthRequestResponse = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });

      const { identityToken } = appleAuthRequestResponse;
      if (!identityToken) throw new Error('No identity token returned.');

      const signInCredentials: SignInWithIdTokenCredentials = {
        provider: 'apple',
        token: identityToken,
      };

      // This call updates the Supabase session globally
      const { error } = await supabase.auth.signInWithIdToken(signInCredentials);
      if (error) throw error;

    } catch (error: any) {
      console.error('Apple Sign-In Error:', error);
    }
  };

  return (
    <GestureDetector gesture={Gesture.Race(panGesture, singleTap)}>
      <View className="flex-1" style={{ paddingBottom: insets.bottom + 10 }}>
        <Animated.View className="mt-auto" style={[rButtonsBlockStyle]}>
          <Pressable className="self-center mb-6" onPress={slideBottomHandler}>
            <ChevronDown size={26} color="grey" />
          </Pressable>
          <Text className="text-center text-3xl font-bold">{t("welcome.title")}</Text>
          <Text className="text-muted text-center mt-3 text-wrap mx-7">
            {t("welcome.subtitle")}
          </Text>
          {isAppleSignInSupported ? (
            <Button
              size="lg"
              className="mx-7 mt-8 gap-2"
              style={{ borderCurve: "continuous" }}
              onPress={appleSignInHandler}>
              <AntDesign name="apple" size={24} color="#1F2840" />
              <Button.Label>{t("welcome.buttons.apple")}</Button.Label>
            </Button>
          ) : null}
        </Animated.View>
        <Button
          size="lg"
          variant="tertiary"
          onPress={expandButtons}
          className="mx-7 mt-4"
          style={{ borderCurve: "continuous", justifyContent: "center" }}
        >
          <View className="justify-center items-center">
            <Animated.View
              style={[rSignUpStyle, { position: "absolute" }]}
            >
              <Button.Label>{t("welcome.buttons.getStarted")}</Button.Label>
            </Animated.View>

            <Animated.View
              style={[rContinueWithEmailStyle, { position: "absolute" }]}
            >
              <Button.Label>{t("welcome.buttons.email")}</Button.Label>
            </Animated.View>
          </View>
        </Button>


        <Carousel
          SLIDES={SLIDES}
          currentSlideIndex={currentSlideIndex}
          setCurrentSlideIndex={setCurrentSlideIndex}
          animatedSlideIndex={animatedSlideIndex}
          horizontalListRef={horizontalListRef}
          scrollHandler={scrollHandler}
          translateY={translateY}
          scrollOffsetX={scrollOffsetX}
          isDragging={isDragging}
          topCarouselOffset={TOP_CAROUSEL_OFFSET}
        />

        <Animated.View className="absolute inset-0 pointer-events-none" style={rGradientStyle}>
          <LinearGradient
            colors={["rgba(0,0,0,0.6)", "transparent"]}
            style={{ width: "100%", height: "60%" }}
          />
        </Animated.View>
      </View>
    </GestureDetector>
  );
};
