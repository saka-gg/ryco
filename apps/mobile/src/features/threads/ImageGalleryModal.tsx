import { createContext, use, useState, type ReactNode } from "react";
import {
  Image,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StatusBar,
  useWindowDimensions,
  View,
} from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { appMotion } from "../../lib/motion";
import {
  galleryBackdropOpacity,
  shouldDismissGallery,
  type GalleryImage,
} from "./messageImageGallery";

/**
 * A message's images full screen: swipe sideways between them, pinch to zoom
 * (the native scroll view's zoom), drag down to close. Share hands the image
 * to the system share sheet.
 */
export function ImageGalleryModal(props: {
  readonly images: ReadonlyArray<GalleryImage>;
  readonly initialIndex: number;
  readonly onClose: () => void;
}) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [index, setIndex] = useState(props.initialIndex);
  // A zoomed image pans with the drag; only an unzoomed one closes on a downward drag.
  const [zoomed, setZoomed] = useState(false);
  const noteZoom = (zoomScale: number | undefined) => {
    const next = (zoomScale ?? 1) > 1.01;
    if (next !== zoomed) setZoomed(next);
  };
  const translateY = useSharedValue(0);
  const { onClose } = props;
  const current = props.images[index] ?? props.images[0];
  const dismiss = Gesture.Pan()
    .enabled(!zoomed)
    // One finger only: a pinch must never start the drag-to-close.
    .maxPointers(1)
    .activeOffsetY(14)
    .failOffsetX([-14, 14])
    .onUpdate((event) => {
      translateY.set(Math.max(event.translationY, 0));
    })
    .onEnd((event) => {
      if (shouldDismissGallery({ translationY: event.translationY, velocityY: event.velocityY })) {
        translateY.set(
          withTiming(height, appMotion.exit, (finished) => {
            if (finished) runOnJS(onClose)();
          }),
        );
      } else {
        translateY.set(withTiming(0, appMotion.enter));
      }
    });
  const imageStyle = useAnimatedStyle(() => ({ transform: [{ translateY: translateY.value }] }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: galleryBackdropOpacity(translateY.value),
  }));
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <StatusBar barStyle="light-content" />
      {/* A modal is its own native root: gestures inside it need their own handler root. */}
      <GestureHandlerRootView style={{ flex: 1 }}>
        <Animated.View
          pointerEvents="none"
          style={[{ position: "absolute", inset: 0, backgroundColor: "#000" }, backdropStyle]}
        />
        <GestureDetector gesture={dismiss}>
          <Animated.View style={[{ flex: 1 }, imageStyle]}>
            <ScrollView
              horizontal
              pagingEnabled
              scrollEnabled={!zoomed}
              showsHorizontalScrollIndicator={false}
              contentOffset={{ x: props.initialIndex * width, y: 0 }}
              onMomentumScrollEnd={(event) => {
                setIndex(Math.round(event.nativeEvent.contentOffset.x / width));
                setZoomed(false);
              }}
            >
              {props.images.map((image) => (
                <ScrollView
                  key={image.id}
                  style={{ width, height }}
                  contentContainerStyle={{ width, height, justifyContent: "center" }}
                  maximumZoomScale={4}
                  minimumZoomScale={1}
                  bouncesZoom
                  centerContent
                  scrollEventThrottle={64}
                  onScroll={(event) => noteZoom(event.nativeEvent.zoomScale)}
                  onScrollEndDrag={(event) => noteZoom(event.nativeEvent.zoomScale)}
                  onMomentumScrollEnd={(event) => noteZoom(event.nativeEvent.zoomScale)}
                  showsHorizontalScrollIndicator={false}
                  showsVerticalScrollIndicator={false}
                >
                  <Image
                    source={{ uri: image.uri }}
                    accessibilityLabel={image.name}
                    resizeMode="contain"
                    style={{
                      width,
                      height: image.aspectRatio
                        ? Math.min(height, width / image.aspectRatio)
                        : height,
                    }}
                  />
                </ScrollView>
              ))}
            </ScrollView>
          </Animated.View>
        </GestureDetector>
        <View
          pointerEvents="box-none"
          className="absolute left-0 right-0 flex-row items-center justify-between px-3"
          style={{ top: insets.top + 4 }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={onClose}
            hitSlop={8}
            className="h-11 w-11 items-center justify-center rounded-full bg-black/50 active:opacity-70"
          >
            <SymbolView name="xmark" size={16} tintColor="#fff" type="monochrome" />
          </Pressable>
          {props.images.length > 1 ? (
            <Text
              className="font-ryco-medium text-sm text-white"
              style={{ fontVariant: ["tabular-nums"] }}
            >
              {index + 1} / {props.images.length}
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Share ${current?.name ?? "image"}`}
            onPress={() => {
              if (current) void Share.share({ url: current.uri }).catch(() => undefined);
            }}
            hitSlop={8}
            className="h-11 w-11 items-center justify-center rounded-full bg-black/50 active:opacity-70"
          >
            <SymbolView name="square.and.arrow.up" size={16} tintColor="#fff" type="monochrome" />
          </Pressable>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

type OpenImageGallery = (images: ReadonlyArray<GalleryImage>, index: number) => void;

const ImageGalleryContext = createContext<OpenImageGallery | null>(null);

function useOwnImageGallery(): { readonly open: OpenImageGallery; readonly modal: ReactNode } {
  const [gallery, setGallery] = useState<{
    readonly images: ReadonlyArray<GalleryImage>;
    readonly index: number;
  } | null>(null);
  const open: OpenImageGallery = (images, index) => {
    if (images.length > 0)
      setGallery({ images, index: Math.min(Math.max(index, 0), images.length - 1) });
  };
  const modal =
    gallery === null ? null : (
      <ImageGalleryModal
        images={gallery.images}
        initialIndex={gallery.index}
        onClose={() => setGallery(null)}
      />
    );
  return { open, modal };
}

/**
 * Owns the gallery for every message beneath it, so it outlives the feed row
 * that opened it: rows unmount and recycle as the feed scrolls and streams.
 */
export function ImageGalleryProvider({ children }: { readonly children: ReactNode }) {
  const { open, modal } = useOwnImageGallery();
  return (
    <ImageGalleryContext value={open}>
      {children}
      {modal}
    </ImageGalleryContext>
  );
}

/** Opens images through the nearest provider, or a modal of the caller's own outside one. */
export function useImageGallery(): { readonly open: OpenImageGallery; readonly modal: ReactNode } {
  const provided = use(ImageGalleryContext);
  const own = useOwnImageGallery();
  return provided === null ? own : { open: provided, modal: null };
}
