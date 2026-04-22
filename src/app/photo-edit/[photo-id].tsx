import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ViewShot from 'react-native-view-shot';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
    ActivityIndicator,
    Alert,
    Animated,
    BackHandler,
    Image as RNImage,
    LayoutChangeEvent,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import Slider from '@react-native-community/slider';
import {
    ChevronLeft,
    Save,
    RotateCw,
    FlipHorizontal2,
    FlipVertical2,
    Undo2,
    Redo2,
    Square,
    RectangleHorizontal,
    Maximize,
    RotateCcw,
} from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import {
    ColorMatrix,
    concatColorMatrices,
    brightness as brightnessMatrix,
    contrast as contrastMatrix,
    saturate as saturateMatrix,
    temperature as temperatureMatrix,
    tint as tintMatrix,
} from '@/src/lib/color-matrix-filters';

import { getPickedAsset } from '@/src/lib/local-sync-store';
import { getAssetById, type AssetInfo } from '@/src/lib/media-library';
import { MOCK_PHOTOS } from '@/src/lib/mock-photos';
import { removeSavedLibraryAsset, saveSavedLibraryAsset } from '@/src/lib/saved-assets-store';
import { EditToolbar, type EditTab } from '@/src/components/photo-edit/EditToolbar';
import { AdjustmentSliders, type Adjustments } from '@/src/components/photo-edit/AdjustmentSliders';
import { FilterPresets, type FilterPreset, FILTER_MATRICES, interpolateMatrix } from '@/src/components/photo-edit/FilterPresets';
import { CropOverlay, type CropTransform } from '@/src/components/photo-edit/CropOverlay';
import { DrawingControls, type DrawPath, type DrawTool } from '@/src/components/photo-edit/DrawingCanvas';
import { TextOnCanvas, TextEditorFullScreen, createTextItem, getTextItemStyle, getTextBoxStyle, type TextItem } from '@/src/components/photo-edit/TextOverlay';
import { Canvas, Path, Skia } from '@shopify/react-native-skia';

const DEFAULT_ADJUSTMENTS: Adjustments = {
    brightness: 1,
    contrast: 1,
    saturation: 1,
    exposure: 1,
    warmth: 0,
    tint: 0,
    highlights: 1,
    shadows: 1,
    sharpness: 0,
};

type AspectRatioOption = {
    label: string;
    value: number | null; // null = free
    Icon: typeof Square;
};

const ASPECT_RATIOS: AspectRatioOption[] = [
    { label: 'Free', value: null, Icon: Maximize },
    { label: '1:1', value: 1, Icon: Square },
    { label: '4:3', value: 4 / 3, Icon: RectangleHorizontal },
    { label: '3:4', value: 3 / 4, Icon: RectangleHorizontal },
    { label: '16:9', value: 16 / 9, Icon: RectangleHorizontal },
    { label: '9:16', value: 9 / 16, Icon: RectangleHorizontal },
];

type EditSnapshot = {
    adjustments: Adjustments;
    activeFilter: FilterPreset;
    filterIntensity: number;
    rotation: number;
    freeRotation: number;
    flipH: boolean;
    flipV: boolean;
    appliedCrop: CropTransform | null;
    drawPaths: DrawPath[];
    textItems: TextItem[];
};

function snapshotEqual(a: EditSnapshot, b: EditSnapshot): boolean {
    return (
        a.rotation === b.rotation &&
        a.freeRotation === b.freeRotation &&
        a.flipH === b.flipH &&
        a.flipV === b.flipV &&
        a.activeFilter === b.activeFilter &&
        a.filterIntensity === b.filterIntensity &&
        a.adjustments === b.adjustments &&
        a.appliedCrop === b.appliedCrop &&
        a.drawPaths === b.drawPaths &&
        a.textItems === b.textItems
    );
}

const INITIAL_SNAPSHOT: EditSnapshot = {
    adjustments: DEFAULT_ADJUSTMENTS,
    activeFilter: 'original',
    filterIntensity: 1,
    rotation: 0,
    freeRotation: 0,
    flipH: false,
    flipV: false,
    appliedCrop: null,
    drawPaths: [],
    textItems: [],
};

type EditablePhotoSource = 'library' | 'picked' | 'mock';
type SaveMode = 'copy' | 'replace';

export default function PhotoEdit() {
    const router = useRouter();
    const { 'photo-id': photoId } = useLocalSearchParams<{ 'photo-id': string }>();
    const insets = useSafeAreaInsets();

    const [imageUri, setImageUri] = useState<string | null>(null);
    const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
    const [editablePhotoSource, setEditablePhotoSource] = useState<EditablePhotoSource>('library');
    const [libraryAssetInfo, setLibraryAssetInfo] = useState<AssetInfo | null>(null);
    const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [activeTab, setActiveTab] = useState<EditTab>('adjust');
    const [adjustments, setAdjustments] = useState<Adjustments>(DEFAULT_ADJUSTMENTS);
    const [activeFilter, setActiveFilter] = useState<FilterPreset>('original');
    const [filterIntensity, setFilterIntensity] = useState(1);

    // ViewShot ref for capturing edited image
    const viewShotRef = useRef<ViewShot>(null);
    const filterPreviewShotRef = useRef<ViewShot>(null);
    const filterPreviewCaptureTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [filterPreviewUri, setFilterPreviewUri] = useState<string | null>(null);
    const [imageReady, setImageReady] = useState(false);

    // Before/After state
    const [showOriginal, setShowOriginal] = useState(false);
    const originalOpacity = useRef(new Animated.Value(0)).current;

    // Transform state
    const [rotation, setRotation] = useState(0); // 0, 90, 180, 270
    const [freeRotation, setFreeRotation] = useState(0); // -45 to 45
    const [flipH, setFlipH] = useState(false);
    const [flipV, setFlipV] = useState(false);

    // Draw & Text state
    const [drawPaths, setDrawPaths] = useState<DrawPath[]>([]);
    const [drawColor, setDrawColor] = useState('#ff3b30');
    const [drawStrokeWidth, setDrawStrokeWidth] = useState(4);
    const [drawOpacity, setDrawOpacity] = useState(1);
    const [drawTool, setDrawTool] = useState<DrawTool>('pen');
    const [activePath, setActivePath] = useState<any>(null);
    const activePathRef = useRef<any>(null);
    const drawGestureRef = useRef<{ startLocalX: number; startLocalY: number; startPageX: number; startPageY: number } | null>(null);
    const [textItems, setTextItems] = useState<TextItem[]>([]);
    const [selectedTextId, setSelectedTextId] = useState<string | null>(null);
    const [drawSubMode, setDrawSubMode] = useState<'pen' | 'text'>('pen');
    const [editingTextId, setEditingTextId] = useState<string | null>(null);

    // Crop state
    const [cropDraft, setCropDraft] = useState<CropTransform | null>(null);
    const [appliedCrop, setAppliedCrop] = useState<CropTransform | null>(null);
    const [selectedAspectRatio, setSelectedAspectRatio] = useState<number | null>(null); // null = free
    const [isCropping, setIsCropping] = useState(false);

    // Undo/Redo history
    const historyRef = useRef<EditSnapshot[]>([INITIAL_SNAPSHOT]);
    const historyIndexRef = useRef(0);
    const [canUndo, setCanUndo] = useState(false);
    const [canRedo, setCanRedo] = useState(false);
    const isUndoRedoRef = useRef(false);

    const pushHistory = useCallback(() => {
        if (isUndoRedoRef.current) return;
        const snap: EditSnapshot = {
            adjustments, activeFilter, filterIntensity,
            rotation, freeRotation, flipH, flipV,
            appliedCrop, drawPaths, textItems,
        };
        const history = historyRef.current;
        const idx = historyIndexRef.current;
        // Don't push if nothing changed
        if (idx < history.length && snapshotEqual(snap, history[idx])) return;
        // Truncate any redo history
        const newHistory = history.slice(0, idx + 1);
        newHistory.push(snap);
        // Keep max 50 entries
        if (newHistory.length > 50) newHistory.shift();
        historyRef.current = newHistory;
        historyIndexRef.current = newHistory.length - 1;
        setCanUndo(newHistory.length > 1);
        setCanRedo(false);
    }, [adjustments, activeFilter, filterIntensity, rotation, freeRotation, flipH, flipV, appliedCrop, drawPaths, textItems]);

    // Auto-push history when state changes (debounced to avoid slider spam)
    const pushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
        if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
        pushTimerRef.current = setTimeout(() => {
            pushHistory();
        }, 300);
        return () => { if (pushTimerRef.current) clearTimeout(pushTimerRef.current); };
    }, [pushHistory]);

    const applySnapshot = useCallback((snap: EditSnapshot) => {
        isUndoRedoRef.current = true;
        setAdjustments(snap.adjustments);
        setActiveFilter(snap.activeFilter);
        setFilterIntensity(snap.filterIntensity);
        setRotation(snap.rotation);
        setFreeRotation(snap.freeRotation);
        setFlipH(snap.flipH);
        setFlipV(snap.flipV);
        setAppliedCrop(snap.appliedCrop);
        setDrawPaths(snap.drawPaths);
        setTextItems(snap.textItems);
        // Reset flag after state settles
        setTimeout(() => { isUndoRedoRef.current = false; }, 50);
    }, []);

    const handleUndo = useCallback(() => {
        const idx = historyIndexRef.current;
        if (idx <= 0) return;
        // First, push current state if it differs from last saved
        const snap: EditSnapshot = {
            adjustments, activeFilter, filterIntensity,
            rotation, freeRotation, flipH, flipV,
            appliedCrop, drawPaths, textItems,
        };
        const history = historyRef.current;
        if (!snapshotEqual(snap, history[idx])) {
            // Current state has unpushed changes — save them first
            const newHistory = history.slice(0, idx + 1);
            newHistory.push(snap);
            historyRef.current = newHistory;
            historyIndexRef.current = newHistory.length - 1;
            // Now undo to previous
            const prevIdx = newHistory.length - 2;
            applySnapshot(newHistory[prevIdx]);
            historyIndexRef.current = prevIdx;
            setCanUndo(prevIdx > 0);
            setCanRedo(true);
        } else {
            const newIdx = idx - 1;
            applySnapshot(history[newIdx]);
            historyIndexRef.current = newIdx;
            setCanUndo(newIdx > 0);
            setCanRedo(true);
        }
    }, [adjustments, activeFilter, filterIntensity, rotation, freeRotation, flipH, flipV, appliedCrop, drawPaths, textItems, applySnapshot]);

    const handleRedo = useCallback(() => {
        const idx = historyIndexRef.current;
        const history = historyRef.current;
        if (idx >= history.length - 1) return;
        const newIdx = idx + 1;
        applySnapshot(history[newIdx]);
        historyIndexRef.current = newIdx;
        setCanUndo(true);
        setCanRedo(newIdx < history.length - 1);
    }, [applySnapshot]);

    const totalRotation = rotation + freeRotation;

    const effectiveImageSize = useMemo(() => {
        const r = rotation % 360;
        if (r === 90 || r === 270) {
            return { width: imageSize.height, height: imageSize.width };
        }
        return imageSize;
    }, [imageSize, rotation]);

    const displayDimensions = useMemo(() => {
        const cw = containerSize.width || 300;
        const ch = containerSize.height || 400;
        const iw = effectiveImageSize.width || 1;
        const ih = effectiveImageSize.height || 1;
        const imageAspect = iw / ih;
        const containerAspect = cw / ch;
        if (imageAspect > containerAspect) {
            return { width: cw, height: cw / imageAspect };
        }
        return { height: ch, width: ch * imageAspect };
    }, [containerSize, effectiveImageSize]);

    const onContainerLayout = useCallback((e: LayoutChangeEvent) => {
        const { width, height } = e.nativeEvent.layout;
        setContainerSize({ width, height });
    }, []);

    // Draw touch handlers
    const previewViewport = useMemo(() => {
        if (isCropping && cropDraft) {
            return {
                width: displayDimensions.width,
                height: displayDimensions.height,
                scale: cropDraft.scale,
                offsetX: cropDraft.offsetX,
                offsetY: cropDraft.offsetY,
            };
        }

        if (appliedCrop) {
            return {
                width: appliedCrop.rect.width,
                height: appliedCrop.rect.height,
                scale: appliedCrop.scale,
                offsetX: appliedCrop.offsetX - appliedCrop.rect.x,
                offsetY: appliedCrop.offsetY - appliedCrop.rect.y,
            };
        }

        return {
            width: displayDimensions.width,
            height: displayDimensions.height,
            scale: 1,
            offsetX: 0,
            offsetY: 0,
        };
    }, [isCropping, cropDraft, appliedCrop, displayDimensions]);

    const previewFrame = useMemo(() => ({
        width: previewViewport.width,
        height: previewViewport.height,
        left: Math.max(0, (containerSize.width - previewViewport.width) / 2),
        top: Math.max(0, (containerSize.height - previewViewport.height) / 2),
        scale: previewViewport.scale,
        offsetX: previewViewport.offsetX,
        offsetY: previewViewport.offsetY,
    }), [containerSize, previewViewport]);

    const mapPreviewPointToScene = useCallback((x: number, y: number) => {
        const scale = Math.max(previewFrame.scale, 0.0001);
        return {
            x: Math.max(0, Math.min((x - previewFrame.offsetX) / scale, displayDimensions.width)),
            y: Math.max(0, Math.min((y - previewFrame.offsetY) / scale, displayDimensions.height)),
        };
    }, [previewFrame.scale, previewFrame.offsetX, previewFrame.offsetY, displayDimensions]);

    const getVisibleSceneBounds = useCallback(() => {
        const topLeft = mapPreviewPointToScene(0, 0);
        const bottomRight = mapPreviewPointToScene(previewFrame.width, previewFrame.height);
        return {
            left: Math.min(topLeft.x, bottomRight.x),
            top: Math.min(topLeft.y, bottomRight.y),
            right: Math.max(topLeft.x, bottomRight.x),
            bottom: Math.max(topLeft.y, bottomRight.y),
        };
    }, [mapPreviewPointToScene, previewFrame.width, previewFrame.height]);

    // Extract points from an SkPath using its SVG string representation
    const getPathPoints = useCallback((skPath: any): { x: number; y: number }[] => {
        const svg: string = skPath.toSVGString?.() ?? '';
        const points: { x: number; y: number }[] = [];
        const regex = /[ML]\s*([-\d.]+)[,\s]+([-\d.]+)/gi;
        let m;
        while ((m = regex.exec(svg)) !== null) {
            points.push({ x: parseFloat(m[1]), y: parseFloat(m[2]) });
        }
        return points;
    }, []);

    // Check if a point is near any segment of a path
    const isPointNearPath = useCallback((px: number, py: number, drawPath: DrawPath, hitRadius: number): boolean => {
        const points = getPathPoints(drawPath.path);
        const radius = hitRadius + drawPath.strokeWidth / 2;
        const r2 = radius * radius;

        for (let i = 0; i < points.length - 1; i++) {
            const a = points[i];
            const b = points[i + 1];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const lenSq = dx * dx + dy * dy;

            let t = 0;
            if (lenSq > 0) {
                t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / lenSq));
            }
            const cx = a.x + t * dx;
            const cy = a.y + t * dy;
            const distSq = (px - cx) * (px - cx) + (py - cy) * (py - cy);
            if (distSq <= r2) return true;
        }

        // Single-point path
        if (points.length === 1) {
            const distSq = (px - points[0].x) * (px - points[0].x) + (py - points[0].y) * (py - points[0].y);
            return distSq <= r2;
        }

        return false;
    }, [getPathPoints]);

    // Split a path by removing segments near the eraser point, returning surviving sub-paths
    const splitPathAtPoint = useCallback((px: number, py: number, drawPath: DrawPath, hitRadius: number): DrawPath[] => {
        const points = getPathPoints(drawPath.path);
        const radius = hitRadius + drawPath.strokeWidth / 2;
        const r2 = radius * radius;

        // Mark each point as erased or not
        const keep = points.map((pt) => {
            const distSq = (px - pt.x) * (px - pt.x) + (py - pt.y) * (py - pt.y);
            return distSq > r2;
        });

        // Also erase points whose segment crosses the eraser circle
        for (let i = 0; i < points.length - 1; i++) {
            const a = points[i];
            const b = points[i + 1];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const lenSq = dx * dx + dy * dy;
            let t = 0;
            if (lenSq > 0) {
                t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / lenSq));
            }
            const cx = a.x + t * dx;
            const cy = a.y + t * dy;
            const distSq = (px - cx) * (px - cx) + (py - cy) * (py - cy);
            if (distSq <= r2) {
                keep[i] = false;
                keep[i + 1] = false;
            }
        }

        // Build sub-paths from surviving contiguous segments
        const result: DrawPath[] = [];
        let currentPoints: { x: number; y: number }[] = [];

        for (let i = 0; i < points.length; i++) {
            if (keep[i]) {
                currentPoints.push(points[i]);
            } else {
                if (currentPoints.length >= 2) {
                    const subPath = Skia.Path.Make();
                    subPath.moveTo(currentPoints[0].x, currentPoints[0].y);
                    for (let j = 1; j < currentPoints.length; j++) {
                        subPath.lineTo(currentPoints[j].x, currentPoints[j].y);
                    }
                    result.push({ ...drawPath, path: subPath });
                }
                currentPoints = [];
            }
        }
        if (currentPoints.length >= 2) {
            const subPath = Skia.Path.Make();
            subPath.moveTo(currentPoints[0].x, currentPoints[0].y);
            for (let j = 1; j < currentPoints.length; j++) {
                subPath.lineTo(currentPoints[j].x, currentPoints[j].y);
            }
            result.push({ ...drawPath, path: subPath });
        }

        return result;
    }, [getPathPoints]);

    const eraseAtPoint = useCallback((cx: number, cy: number) => {
        const HIT_RADIUS = 12;
        setDrawPaths(prev => {
            let changed = false;
            const next: DrawPath[] = [];
            for (const p of prev) {
                if (isPointNearPath(cx, cy, p, HIT_RADIUS)) {
                    changed = true;
                    const fragments = splitPathAtPoint(cx, cy, p, HIT_RADIUS);
                    next.push(...fragments);
                } else {
                    next.push(p);
                }
            }
            return changed ? next : prev;
        });
    }, [isPointNearPath, splitPathAtPoint]);

    const handleDrawStart = useCallback((x: number, y: number) => {
        const { x: cx, y: cy } = mapPreviewPointToScene(x, y);
        if (drawTool === 'eraser') {
            eraseAtPoint(cx, cy);
            return;
        }
        const path = Skia.Path.Make();
        path.moveTo(cx, cy);
        activePathRef.current = path;
        setActivePath(path);
    }, [drawTool, mapPreviewPointToScene, eraseAtPoint]);

    const handleDrawMove = useCallback((x: number, y: number) => {
        const { x: cx, y: cy } = mapPreviewPointToScene(x, y);
        if (drawTool === 'eraser') {
            eraseAtPoint(cx, cy);
            return;
        }
        if (activePathRef.current) {
            activePathRef.current.lineTo(cx, cy);
            setActivePath(Skia.Path.MakeFromSVGString(activePathRef.current.toSVGString()));
        }
    }, [drawTool, mapPreviewPointToScene, eraseAtPoint]);

    const handleDrawEnd = useCallback(() => {
        if (drawTool === 'eraser') return;
        if (activePathRef.current) {
            const opacity = drawTool === 'marker' ? Math.min(drawOpacity, 0.5) : drawOpacity;
            const newPath: DrawPath = {
                path: activePathRef.current,
                color: drawColor,
                strokeWidth: drawStrokeWidth,
                opacity,
            };
            setDrawPaths(prev => [...prev, newPath]);
            activePathRef.current = null;
            setActivePath(null);
        }
    }, [drawColor, drawStrokeWidth, drawOpacity, drawTool]);

    // Draw-specific undo/redo
    const handleDrawToolChange = useCallback((tool: DrawTool) => {
        setDrawTool(tool);
        setDrawSubMode('pen');
        setSelectedTextId(null);
        if (tool === 'marker' && drawOpacity > 0.5) {
            setDrawOpacity(0.4);
        } else if (tool === 'pen' && drawOpacity < 0.5) {
            setDrawOpacity(1);
        }
    }, [drawOpacity]);

    // Add new text — opens Samsung-style full-screen editor
    const handleAddNewText = useCallback(() => {
        const visibleBounds = getVisibleSceneBounds();
        const newItem = createTextItem('#ffffff', 28, displayDimensions.width || 300, displayDimensions.height || 400, 0);
        const approxWidth = 50;
        const approxHeight = newItem.fontSize * 1.3;
        newItem.x = Math.max(0, Math.min((visibleBounds.left + visibleBounds.right) / 2 - approxWidth / 2, displayDimensions.width - approxWidth));
        newItem.y = Math.max(0, Math.min((visibleBounds.top + visibleBounds.bottom) / 2 - approxHeight / 2, displayDimensions.height - approxHeight));
        setTextItems(prev => [...prev, newItem]);
        setSelectedTextId(newItem.id);
        setEditingTextId(newItem.id);
    }, [displayDimensions, getVisibleSceneBounds]);

    // Commit from full-screen editor
    const handleTextEditorCommit = useCallback((id: string, text: string, updates: Partial<TextItem>) => {
        if (!text.trim()) {
            setTextItems(prev => prev.filter(t => t.id !== id));
            setSelectedTextId(null);
        } else {
            setTextItems(prev => prev.map(t =>
                t.id === id ? { ...t, text, ...updates } : t
            ));
        }
        setEditingTextId(null);
    }, []);
    const hasChanges = useMemo(() => {
        return rotation !== 0 ||
            freeRotation !== 0 ||
            flipH ||
            flipV ||
            appliedCrop !== null ||
            adjustments.brightness !== 1 ||
            adjustments.contrast !== 1 ||
            adjustments.saturation !== 1 ||
            adjustments.exposure !== 1 ||
            adjustments.warmth !== 0 ||
            adjustments.tint !== 0 ||
            adjustments.highlights !== 1 ||
            adjustments.shadows !== 1 ||
            adjustments.sharpness !== 0 ||
            activeFilter !== 'original' ||
            drawPaths.length > 0 ||
            textItems.length > 0;
    }, [rotation, freeRotation, flipH, flipV, appliedCrop, adjustments, activeFilter, drawPaths, textItems]);

    // Before/After handlers
    const handlePressIn = useCallback(() => {
        if (!hasChanges || isCropping) return;
        setShowOriginal(true);
        Animated.timing(originalOpacity, {
            toValue: 1,
            duration: 150,
            useNativeDriver: true,
        }).start();
    }, [hasChanges, isCropping, originalOpacity]);

    const handlePressOut = useCallback(() => {
        Animated.timing(originalOpacity, {
            toValue: 0,
            duration: 150,
            useNativeDriver: true,
        }).start(() => setShowOriginal(false));
    }, [originalOpacity]);

    useEffect(() => {
        let isMounted = true;

        async function loadPhoto() {
            if (!photoId) return;

            const mock = MOCK_PHOTOS.find((p) => p.id === photoId);
            if (mock) {
                if (!isMounted) return;
                setEditablePhotoSource('mock');
                setLibraryAssetInfo(null);
                setImageUri(mock.uri);
                setImageSize({ width: mock.width, height: mock.height });
                setIsLoading(false);
                return;
            }

            if (photoId.startsWith('picked:')) {
                const pickedAsset = await getPickedAsset(photoId);
                if (!isMounted) return;
                setEditablePhotoSource('picked');
                setLibraryAssetInfo(null);
                if (pickedAsset?.uri) {
                    setImageUri(pickedAsset.uri);
                    if (pickedAsset.width && pickedAsset.height) {
                        setImageSize({ width: pickedAsset.width, height: pickedAsset.height });
                    }
                }
                setIsLoading(false);
                return;
            }

            try {
                const info = await getAssetById(photoId);
                if (!isMounted) return;
                setEditablePhotoSource('library');
                setLibraryAssetInfo(info);
                setImageUri(info?.localUri ?? info?.uri ?? null);
                if (info) setImageSize({ width: info.width, height: info.height });
            } catch {
                // ignore
            } finally {
                if (isMounted) setIsLoading(false);
            }
        }

        loadPhoto();
        return () => { isMounted = false; };
    }, [photoId]);

    const handleReset = useCallback(() => {
        setAdjustments(DEFAULT_ADJUSTMENTS);
        setActiveFilter('original');
        setFilterIntensity(1);
        setRotation(0);
        setFreeRotation(0);
        setFlipH(false);
        setFlipV(false);
        setCropDraft(null);
        setAppliedCrop(null);
        setIsCropping(false);
        setSelectedAspectRatio(null);
        setDrawPaths([]);
        setTextItems([]);
        setSelectedTextId(null);
        setEditingTextId(null);
        setDrawSubMode('pen');
        // Reset history
        historyRef.current = [INITIAL_SNAPSHOT];
        historyIndexRef.current = 0;
        setCanUndo(false);
        setCanRedo(false);
    }, []);

    // Crop handlers
    const createDefaultCrop = useCallback((): CropTransform => ({
        rect: {
            x: displayDimensions.width * 0.1,
            y: displayDimensions.height * 0.1,
            width: displayDimensions.width * 0.8,
            height: displayDimensions.height * 0.8,
        },
        scale: 1,
        offsetX: 0,
        offsetY: 0,
    }), [displayDimensions]);

    const handleStartCrop = useCallback(() => {
        setIsCropping(true);
        setCropDraft(appliedCrop
            ? { ...appliedCrop, rect: { ...appliedCrop.rect } }
            : createDefaultCrop());
    }, [appliedCrop, createDefaultCrop]);

    const handleCancelCrop = useCallback(() => {
        setIsCropping(false);
        setCropDraft(null);
        setSelectedAspectRatio(null);
    }, []);

    const handleApplyCrop = useCallback(() => {
        if (cropDraft) {
            setAppliedCrop(cropDraft);
        }
        setIsCropping(false);
        setCropDraft(null);
        setSelectedAspectRatio(null);
    }, [cropDraft]);

    const handleAspectRatioChange = useCallback((ratio: number | null) => {
        setSelectedAspectRatio(ratio);
        if (!ratio) return;
        setCropDraft((prev) => {
            if (!prev) return prev;
            const centerX = prev.rect.x + prev.rect.width / 2;
            const centerY = prev.rect.y + prev.rect.height / 2;
            let newW = prev.rect.width;
            let newH = newW / ratio;
            if (newH > displayDimensions.height * 0.8) {
                newH = displayDimensions.height * 0.8;
                newW = newH * ratio;
            }
            if (newW > displayDimensions.width * 0.9) {
                newW = displayDimensions.width * 0.9;
                newH = newW / ratio;
            }
            const newX = Math.max(0, Math.min(centerX - newW / 2, displayDimensions.width - newW));
            const newY = Math.max(0, Math.min(centerY - newH / 2, displayDimensions.height - newH));
            return {
                ...prev,
                rect: { x: newX, y: newY, width: newW, height: newH },
            };
        });
    }, [displayDimensions]);

    const hasColorChanges = useMemo(() => {
        return adjustments.brightness !== 1 ||
            adjustments.contrast !== 1 ||
            adjustments.saturation !== 1 ||
            adjustments.exposure !== 1 ||
            adjustments.warmth !== 0 ||
            adjustments.tint !== 0 ||
            adjustments.highlights !== 1 ||
            adjustments.shadows !== 1 ||
            adjustments.sharpness !== 0 ||
            activeFilter !== 'original';
    }, [adjustments, activeFilter]);

    const colorMatrix = useMemo(() => {
        if (!hasColorChanges) return null;
        const matrices: number[][] = [];

        const totalBrightness = adjustments.brightness * adjustments.exposure;
        if (totalBrightness !== 1) matrices.push([...brightnessMatrix(totalBrightness)]);

        if (adjustments.contrast !== 1) matrices.push([...contrastMatrix(adjustments.contrast)]);

        if (adjustments.highlights !== 1) {
            const h = adjustments.highlights;
            matrices.push([...brightnessMatrix(1 + (h - 1) * 0.3)]);
        }

        if (adjustments.shadows !== 1) {
            const s = adjustments.shadows;
            const offset = (s - 1) * 0.15;
            matrices.push([
                1, 0, 0, 0, offset,
                0, 1, 0, 0, offset,
                0, 0, 1, 0, offset,
                0, 0, 0, 1, 0,
            ]);
        }

        if (adjustments.saturation !== 1) matrices.push([...saturateMatrix(adjustments.saturation)]);

        if (adjustments.warmth !== 0) {
            const t = adjustments.warmth / 100;
            matrices.push([...temperatureMatrix(t)]);
        }

        if (adjustments.tint !== 0) {
            const t = adjustments.tint / 100;
            matrices.push([...tintMatrix(t)]);
        }

        // Sharpness simulation: boost midtone contrast + edge clarity
        if (adjustments.sharpness !== 0) {
            const s = adjustments.sharpness; // 0 to 1
            // Increase contrast in a way that enhances perceived sharpness
            const contrastBoost = 1 + s * 0.4;
            // Also slightly increase saturation for clarity feel
            const satBoost = 1 + s * 0.15;
            matrices.push([...contrastMatrix(contrastBoost)]);
            matrices.push([...saturateMatrix(satBoost)]);
            // Slight offset to keep brightness neutral after contrast boost
            const offset = -s * 0.08;
            matrices.push([
                1, 0, 0, 0, offset,
                0, 1, 0, 0, offset,
                0, 0, 1, 0, offset,
                0, 0, 0, 1, 0,
            ]);
        }

        if (activeFilter !== 'original') {
            const filterMat = [...FILTER_MATRICES[activeFilter]] as number[];
            if (filterIntensity < 1) {
                matrices.push(interpolateMatrix(filterMat, filterIntensity));
            } else {
                matrices.push(filterMat);
            }
        }

        if (matrices.length === 0) return null;
        if (matrices.length === 1) return matrices[0] as any;
        return concatColorMatrices(...(matrices as any));
    }, [adjustments, activeFilter, filterIntensity, hasColorChanges]);

    // Adjustments-only matrix (no filter) — for filter preview thumbnails
    const adjustmentsMatrix = useMemo(() => {
        const matrices: number[][] = [];
        const totalBrightness = adjustments.brightness * adjustments.exposure;
        if (totalBrightness !== 1) matrices.push([...brightnessMatrix(totalBrightness)]);
        if (adjustments.contrast !== 1) matrices.push([...contrastMatrix(adjustments.contrast)]);
        if (adjustments.highlights !== 1) matrices.push([...brightnessMatrix(1 + (adjustments.highlights - 1) * 0.3)]);
        if (adjustments.shadows !== 1) {
            const offset = (adjustments.shadows - 1) * 0.15;
            matrices.push([1,0,0,0,offset, 0,1,0,0,offset, 0,0,1,0,offset, 0,0,0,1,0]);
        }
        if (adjustments.saturation !== 1) matrices.push([...saturateMatrix(adjustments.saturation)]);
        if (adjustments.warmth !== 0) matrices.push([...temperatureMatrix(adjustments.warmth / 100)]);
        if (adjustments.tint !== 0) matrices.push([...tintMatrix(adjustments.tint / 100)]);
        if (adjustments.sharpness !== 0) {
            matrices.push([...contrastMatrix(1 + adjustments.sharpness * 0.4)]);
            matrices.push([...saturateMatrix(1 + adjustments.sharpness * 0.15)]);
            const o = -adjustments.sharpness * 0.08;
            matrices.push([1,0,0,0,o, 0,1,0,0,o, 0,0,1,0,o, 0,0,0,1,0]);
        }
        if (matrices.length === 0) return null;
        if (matrices.length === 1) return matrices[0];
        return concatColorMatrices(...(matrices as any));
    }, [adjustments]);

    const imageTransform = useMemo(() => {
        const transforms: any[] = [];
        if (totalRotation !== 0) transforms.push({ rotate: `${totalRotation}deg` });
        if (flipH) transforms.push({ scaleX: -1 });
        if (flipV) transforms.push({ scaleY: -1 });
        return transforms.length > 0 ? transforms : undefined;
    }, [totalRotation, flipH, flipV]);

    useEffect(() => {
        setFilterPreviewUri(null);
    }, [imageUri]);

    useEffect(() => {
        if (filterPreviewCaptureTimeoutRef.current) {
            clearTimeout(filterPreviewCaptureTimeoutRef.current);
            filterPreviewCaptureTimeoutRef.current = null;
        }

        if (
            !imageUri ||
            !imageReady ||
            isCropping ||
            editingTextId ||
            containerSize.width <= 0 ||
            containerSize.height <= 0 ||
            displayDimensions.width <= 0 ||
            displayDimensions.height <= 0
        ) {
            return;
        }

        filterPreviewCaptureTimeoutRef.current = setTimeout(async () => {
            try {
                const capturedUri = await filterPreviewShotRef.current?.capture?.();
                if (capturedUri) {
                    setFilterPreviewUri(capturedUri);
                }
            } catch (error) {
                console.warn('Filter preview capture failed', error);
            }
        }, 180);

        return () => {
            if (filterPreviewCaptureTimeoutRef.current) {
                clearTimeout(filterPreviewCaptureTimeoutRef.current);
                filterPreviewCaptureTimeoutRef.current = null;
            }
        };
    }, [
        imageUri,
        imageReady,
        isCropping,
        editingTextId,
        containerSize.width,
        containerSize.height,
        displayDimensions.width,
        displayDimensions.height,
        rotation,
        freeRotation,
        flipH,
        flipV,
        appliedCrop,
        adjustments,
        drawPaths,
        textItems,
    ]);

    const canReplaceOriginal = editablePhotoSource === 'library' && !!photoId && !!libraryAssetInfo;

    const captureEditedImageUri = useCallback(async () => {
        if (viewShotRef.current?.capture) {
            return await viewShotRef.current.capture();
        }

        if (!imageUri) {
            throw new Error('No image available to capture.');
        }

        return imageUri;
    }, [imageUri]);

    const prepareCapturedImageForLibrarySave = useCallback(async () => {
        const capturedUri = await captureEditedImageUri();

        if (!FileSystem.cacheDirectory) {
            throw new Error('Cache directory is unavailable.');
        }

        const normalizedCapturedUri = capturedUri.startsWith('file://')
            ? capturedUri
            : capturedUri.replace(/^file:/, 'file://');
        const tempSaveUri = `${FileSystem.cacheDirectory}smart-gallery-save-${Date.now()}.jpg`;

        await FileSystem.copyAsync({
            from: normalizedCapturedUri,
            to: tempSaveUri,
        });

        return tempSaveUri;
    }, [captureEditedImageUri]);

    const saveEditedPhoto = useCallback(async (mode: SaveMode) => {
        if (!imageUri) return;

        setIsSaving(true);
        let tempSaveUri: string | null = null;
        try {
            const { status } = await MediaLibrary.requestPermissionsAsync();
            if (status !== 'granted') {
                Alert.alert('Permission Required', 'Storage permission is needed.');
                return;
            }

            tempSaveUri = await prepareCapturedImageForLibrarySave();

            if (mode === 'replace') {
                if (!photoId || !libraryAssetInfo) {
                    Alert.alert('Unavailable', 'Replace Original is not available for this photo.');
                    return;
                }

                const replacementAsset = await MediaLibrary.createAssetAsync(tempSaveUri);

                try {
                    await MediaLibrary.deleteAssetsAsync([photoId]);
                } catch (deleteError) {
                    try {
                        await MediaLibrary.deleteAssetsAsync([replacementAsset.id]);
                    } catch {
                        // Best effort cleanup only.
                    }
                    throw deleteError;
                }

                await removeSavedLibraryAsset(photoId);
                await saveSavedLibraryAsset(replacementAsset);

                Alert.alert('Saved!', 'Photo replaced in your gallery.', [
                    {
                        text: 'OK',
                        onPress: () => {
                            router.dismissTo('/home');
                            requestAnimationFrame(() => {
                                router.push(`/photo-detail/${replacementAsset.id}` as any);
                            });
                        },
                    },
                ]);
                return;
            }

            const newAsset = await MediaLibrary.createAssetAsync(tempSaveUri);
            await saveSavedLibraryAsset(newAsset);
            Alert.alert('Saved!', 'Photo saved to your gallery.', [
                { text: 'OK', onPress: () => router.back() },
            ]);
        } catch (e) {
            console.error('Save error:', e);
            Alert.alert('Error', 'Could not save the photo.');
        } finally {
            if (tempSaveUri) {
                try {
                    await FileSystem.deleteAsync(tempSaveUri, { idempotent: true });
                } catch {
                    // Best effort cleanup only.
                }
            }
            setIsSaving(false);
        }
    }, [imageUri, libraryAssetInfo, photoId, prepareCapturedImageForLibrarySave, router]);

    const promptSaveOptions = useCallback(() => {
        if (isSaving) return;

        const buttons: { text: string; style?: 'cancel' | 'default' | 'destructive'; onPress?: () => void }[] = [
            { text: 'Save as Copy', onPress: () => { void saveEditedPhoto('copy'); } },
        ];

        if (canReplaceOriginal) {
            buttons.push({ text: 'Replace Original', onPress: () => { void saveEditedPhoto('replace'); } });
        }

        buttons.push({ text: 'Cancel', style: 'cancel' });

        Alert.alert('Save Photo', 'Choose how you want to save this edit.', buttons);
    }, [canReplaceOriginal, isSaving, saveEditedPhoto]);

    const handleSave = useCallback(() => {
        promptSaveOptions();
    }, [promptSaveOptions]);

    const handleBack = useCallback(() => {
        if (hasChanges) {
            Alert.alert('Unsaved Changes', 'What would you like to do with this edit?', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Discard', style: 'destructive', onPress: () => router.back() },
                { text: 'Save', onPress: () => promptSaveOptions() },
            ]);
        } else {
            router.back();
        }
    }, [hasChanges, promptSaveOptions, router]);

    useEffect(() => {
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            handleBack();
            return true;
        });
        return () => sub.remove();
    }, [handleBack]);

    const handleFilterChange = useCallback((filter: FilterPreset) => {
        setActiveFilter(filter);
        if (filter !== 'original') setFilterIntensity(1);
    }, []);

    // When switching to crop tab, start cropping mode
    const handleTabChange = useCallback((tab: EditTab) => {
        if (tab !== 'crop' && isCropping) {
            setIsCropping(false);
        }
        if (tab !== 'draw') {
            setEditingTextId(null);
            setSelectedTextId(null);
        }
        setActiveTab(tab);
    }, [isCropping]);

    if (isLoading) {
        return (
            <View style={[styles.center, { paddingTop: insets.top }]}>
                <ActivityIndicator size="large" color="#818cf8" />
            </View>
        );
    }

    if (!imageUri) {
        return (
            <View style={[styles.center, { paddingTop: insets.top }]}>
                <Text style={styles.errorText}>Photo not found.</Text>
                <TouchableOpacity onPress={() => router.back()} style={styles.goBackBtn}>
                    <Text style={styles.goBackBtnText}>Go Back</Text>
                </TouchableOpacity>
            </View>
        );
    }

    const imageElement = (
        <RNImage
            source={{ uri: imageUri }}
            style={{ width: displayDimensions.width, height: displayDimensions.height }}
            resizeMode="contain"
            onLoad={() => { if (!imageReady) setImageReady(true); }}
        />
    );

    const colorImage = colorMatrix ? (
        <ColorMatrix matrix={colorMatrix}>
            {imageElement}
        </ColorMatrix>
    ) : (
        imageElement
    );

    const adjustmentsOnlyImage = adjustmentsMatrix ? (
        <ColorMatrix matrix={adjustmentsMatrix as any}>
            {imageElement}
        </ColorMatrix>
    ) : (
        imageElement
    );

    const renderOverlayLayers = () => (
        <>
            {(drawPaths.length > 0 || activePath) && (
                <View style={[styles.drawOverlay, {
                    width: displayDimensions.width,
                    height: displayDimensions.height,
                    overflow: 'hidden',
                }]} pointerEvents="none">
                    <Canvas style={{ width: displayDimensions.width, height: displayDimensions.height }}>
                        {drawPaths.map((p, i) => (
                            <Path
                                key={i}
                                path={p.path}
                                color={p.color}
                                style="stroke"
                                strokeWidth={p.strokeWidth}
                                strokeCap="round"
                                strokeJoin="round"
                                opacity={p.opacity}
                            />
                        ))}
                        {activePath && (
                            <Path
                                path={activePath}
                                color={drawColor}
                                style="stroke"
                                strokeWidth={drawStrokeWidth}
                                strokeCap="round"
                                strokeJoin="round"
                                opacity={drawTool === 'marker' ? Math.min(drawOpacity, 0.5) : drawOpacity}
                            />
                        )}
                    </Canvas>
                </View>
            )}

            {textItems.length > 0 && (
                <View style={[styles.drawOverlay, {
                    width: displayDimensions.width,
                    height: displayDimensions.height,
                }]} pointerEvents="none">
                    {textItems.map((item) => {
                        const boxStyle = getTextBoxStyle(item);
                        return (
                            <View
                                key={item.id}
                                style={{
                                    position: 'absolute',
                                    left: item.x,
                                    top: item.y,
                                    transform: item.rotation !== 0
                                        ? [{ rotate: `${item.rotation}deg` }]
                                        : undefined,
                                    opacity: item.id === editingTextId ? 0 : 1,
                                    ...(boxStyle || {}),
                                }}
                            >
                                <Text style={getTextItemStyle(item)}>
                                    {item.text}
                                </Text>
                            </View>
                        );
                    })}
                </View>
            )}
        </>
    );

    const getSceneTransformStyle = (scale: number, offsetX: number, offsetY: number) => ({
        position: 'absolute' as const,
        width: displayDimensions.width,
        height: displayDimensions.height,
        left: offsetX - (displayDimensions.width * (1 - scale)) / 2,
        top: offsetY - (displayDimensions.height * (1 - scale)) / 2,
        transform: scale !== 1 ? [{ scale }] : undefined,
    });

    const renderSceneSurface = (baseImage: ReactNode) => (
        <View style={[styles.sceneSurface, { width: displayDimensions.width, height: displayDimensions.height }]}>
            <View style={[styles.sceneImageLayer, imageTransform ? { transform: imageTransform } : undefined]}>
                {baseImage}
            </View>
            {renderOverlayLayers()}
        </View>
    );

    const renderPreviewFrame = (baseImage: ReactNode, cropState: CropTransform | null) => {
        const frameWidth = cropState ? cropState.rect.width : displayDimensions.width;
        const frameHeight = cropState ? cropState.rect.height : displayDimensions.height;
        const scale = cropState?.scale ?? 1;
        const offsetX = cropState ? cropState.offsetX - cropState.rect.x : 0;
        const offsetY = cropState ? cropState.offsetY - cropState.rect.y : 0;

        return (
            <View style={{ width: frameWidth, height: frameHeight, overflow: 'hidden' }}>
                <View style={getSceneTransformStyle(scale, offsetX, offsetY)}>
                    {renderSceneSurface(baseImage)}
                </View>
            </View>
        );
    };

    const renderCropEditorFrame = (baseImage: ReactNode, cropState: CropTransform) => (
        <View style={{ width: displayDimensions.width, height: displayDimensions.height, overflow: 'hidden' }}>
            <View style={getSceneTransformStyle(cropState.scale, cropState.offsetX, cropState.offsetY)}>
                {renderSceneSurface(baseImage)}
            </View>
        </View>
    );

    const renderedMainPreview = isCropping && cropDraft
        ? renderCropEditorFrame(colorImage, cropDraft)
        : renderPreviewFrame(colorImage, appliedCrop);
    const filterPreviewBaseImage = renderPreviewFrame(adjustmentsOnlyImage, appliedCrop);
    const captureSize = {
        width: appliedCrop && !isCropping ? appliedCrop.rect.width : displayDimensions.width,
        height: appliedCrop && !isCropping ? appliedCrop.rect.height : displayDimensions.height,
    };
    const visibleSceneBounds = getVisibleSceneBounds();
    const previewInteractiveFrameStyle = {
        width: previewFrame.width,
        height: previewFrame.height,
        left: previewFrame.left,
        top: previewFrame.top,
    };

    return (
        <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
            {/* Top Bar */}
            <View style={styles.topBar}>
                <TouchableOpacity onPress={handleBack} style={styles.iconBtn} hitSlop={8}>
                    <ChevronLeft size={24} color="#e5e7eb" />
                </TouchableOpacity>
                <View style={styles.topBarCenter}>
                    {!isCropping && (
                        <View style={styles.undoRedoRow}>
                            <TouchableOpacity
                                onPress={handleUndo}
                                disabled={!canUndo}
                                style={[styles.undoRedoBtn, !canUndo && styles.undoRedoBtnDisabled]}
                                hitSlop={6}
                            >
                                <Undo2 size={18} color="#e5e7eb" />
                            </TouchableOpacity>
                            <TouchableOpacity
                                onPress={handleRedo}
                                disabled={!canRedo}
                                style={[styles.undoRedoBtn, !canRedo && styles.undoRedoBtnDisabled]}
                                hitSlop={6}
                            >
                                <Redo2 size={18} color="#e5e7eb" />
                            </TouchableOpacity>
                            {hasChanges && (
                                <TouchableOpacity onPress={handleReset} style={styles.resetBtn} hitSlop={4}>
                                    <Text style={styles.resetBtnText}>Reset</Text>
                                </TouchableOpacity>
                            )}
                        </View>
                    )}
                    {isCropping && (
                        <View style={styles.cropActions}>
                            <TouchableOpacity onPress={handleCancelCrop} style={styles.cropCancelBtn}>
                                <Text style={styles.cropCancelText}>Cancel</Text>
                            </TouchableOpacity>
                            <TouchableOpacity onPress={handleApplyCrop} style={styles.cropApplyBtn}>
                                <Text style={styles.cropApplyText}>Apply</Text>
                            </TouchableOpacity>
                        </View>
                    )}
                </View>
                <TouchableOpacity
                    onPress={handleSave}
                    disabled={isSaving || !hasChanges || isCropping}
                    style={[styles.saveBtn, (!hasChanges || isSaving || isCropping) && styles.saveBtnDisabled]}
                >
                    {isSaving ? (
                        <ActivityIndicator size="small" color="#fff" />
                    ) : (
                        <>
                            <Save size={16} color="#fff" />
                            <Text style={styles.saveBtnText}>Save</Text>
                        </>
                    )}
                </TouchableOpacity>
            </View>

            {/* Image Preview */}
            <Pressable
                style={styles.imageContainer}
                onLayout={onContainerLayout}
                onPressIn={(activeTab !== 'draw' && !isCropping) ? handlePressIn : undefined}
                onPressOut={(activeTab !== 'draw' && !isCropping) ? handlePressOut : undefined}
            >
                {/* ViewShot wraps everything that should be captured on save */}
                <ViewShot
                    ref={viewShotRef}
                    options={{ format: 'jpg', quality: 0.95 }}
                    style={{
                        width: captureSize.width,
                        height: captureSize.height,
                        justifyContent: 'center',
                        alignItems: 'center',
                        overflow: 'hidden',
                    }}
                >
                    {renderedMainPreview}
                </ViewShot>

                {/* Draw touch handler — pen/marker/eraser mode */}
                {activeTab === 'draw' && drawSubMode === 'pen' && (
                    <View
                        style={[styles.interactiveOverlayFrame, previewInteractiveFrameStyle]}
                        onStartShouldSetResponder={() => true}
                        onMoveShouldSetResponder={() => true}
                        onResponderStart={(e) => {
                            drawGestureRef.current = {
                                startLocalX: e.nativeEvent.locationX,
                                startLocalY: e.nativeEvent.locationY,
                                startPageX: e.nativeEvent.pageX,
                                startPageY: e.nativeEvent.pageY,
                            };
                            handleDrawStart(e.nativeEvent.locationX, e.nativeEvent.locationY);
                        }}
                        onResponderMove={(e) => {
                            const gesture = drawGestureRef.current;
                            if (!gesture) return;
                            const localX = gesture.startLocalX + (e.nativeEvent.pageX - gesture.startPageX);
                            const localY = gesture.startLocalY + (e.nativeEvent.pageY - gesture.startPageY);
                            handleDrawMove(localX, localY);
                        }}
                        onResponderRelease={() => {
                            drawGestureRef.current = null;
                            handleDrawEnd();
                        }}
                        onResponderTerminate={() => {
                            drawGestureRef.current = null;
                            handleDrawEnd();
                        }}
                    />
                )}

                {/* Text interactive overlay — show when texts exist OR in text sub-mode */}
                {activeTab === 'draw' && (drawSubMode === 'text' || textItems.length > 0) && !editingTextId && (
                    <View style={[styles.interactiveOverlayFrame, previewInteractiveFrameStyle]} pointerEvents={drawSubMode === 'pen' ? 'none' : 'auto'}>
                        <TextOnCanvas
                            textItems={textItems}
                            onTextItemsChange={setTextItems}
                            selectedItemId={selectedTextId}
                            onSelectItem={setSelectedTextId}
                            onStartEditing={setEditingTextId}
                            sceneWidth={displayDimensions.width}
                            sceneHeight={displayDimensions.height}
                            viewportWidth={previewFrame.width}
                            viewportHeight={previewFrame.height}
                            viewportScale={previewFrame.scale}
                            viewportOffsetX={previewFrame.offsetX}
                            viewportOffsetY={previewFrame.offsetY}
                            allowedLeft={visibleSceneBounds.left}
                            allowedTop={visibleSceneBounds.top}
                            allowedRight={visibleSceneBounds.right}
                            allowedBottom={visibleSceneBounds.bottom}
                        />
                    </View>
                )}

                {/* Crop overlay */}
                {isCropping && cropDraft && (
                    <View style={[styles.cropOverlayContainer, styles.interactiveOverlayFrame, previewInteractiveFrameStyle]}>
                        <CropOverlay
                            crop={cropDraft}
                            onCropChange={setCropDraft}
                            containerWidth={displayDimensions.width}
                            containerHeight={displayDimensions.height}
                            aspectRatio={selectedAspectRatio}
                        />
                    </View>
                )}

                {/* Before/After overlay */}
                {showOriginal && (
                    <Animated.View style={[styles.originalOverlay, { opacity: originalOpacity }]}>
                        <RNImage
                            source={{ uri: imageUri }}
                            style={{ width: displayDimensions.width, height: displayDimensions.height }}
                            resizeMode="contain"
                        />
                        <View style={styles.originalBadge}>
                            <Text style={styles.originalBadgeText}>ORIGINAL</Text>
                        </View>
                    </Animated.View>
                )}
            </Pressable>

            {/* Tool Panel */}
            <View style={styles.toolPanel}>
                {activeTab === 'crop' && (
                    <View style={styles.transformPanel}>
                        {/* Transform buttons row */}
                        <View style={styles.transformRow}>
                            <TouchableOpacity onPress={() => setRotation(r => (r + 90) % 360)} style={styles.transformBtn}>
                                <View style={[styles.transformIcon, rotation !== 0 && styles.transformIconActive]}>
                                    <RotateCw size={20} color="#e5e7eb" />
                                </View>
                                <Text style={[styles.transformLabel, rotation !== 0 && styles.transformLabelActive]}>Rotate</Text>
                            </TouchableOpacity>
                            <TouchableOpacity onPress={() => setFlipH(f => !f)} style={styles.transformBtn}>
                                <View style={[styles.transformIcon, flipH && styles.transformIconActive]}>
                                    <FlipHorizontal2 size={20} color="#e5e7eb" />
                                </View>
                                <Text style={[styles.transformLabel, flipH && styles.transformLabelActive]}>Flip H</Text>
                            </TouchableOpacity>
                            <TouchableOpacity onPress={() => setFlipV(f => !f)} style={styles.transformBtn}>
                                <View style={[styles.transformIcon, flipV && styles.transformIconActive]}>
                                    <FlipVertical2 size={20} color="#e5e7eb" />
                                </View>
                                <Text style={[styles.transformLabel, flipV && styles.transformLabelActive]}>Flip V</Text>
                            </TouchableOpacity>
                            <TouchableOpacity onPress={isCropping ? handleCancelCrop : handleStartCrop} style={styles.transformBtn}>
                                <View style={[styles.transformIcon, isCropping && styles.transformIconActive]}>
                                    <Maximize size={20} color="#e5e7eb" />
                                </View>
                                <Text style={[styles.transformLabel, isCropping && styles.transformLabelActive]}>Crop</Text>
                            </TouchableOpacity>
                        </View>

                        {/* Free rotation slider */}
                        <View style={styles.freeRotationRow}>
                            <RotateCcw size={14} color="#6b7280" />
                            <Slider
                                style={styles.freeRotationSlider}
                                minimumValue={-45}
                                maximumValue={45}
                                step={0.5}
                                value={freeRotation}
                                onValueChange={setFreeRotation}
                                minimumTrackTintColor="#6366f1"
                                maximumTrackTintColor="#262626"
                                thumbTintColor="#818cf8"
                            />
                            <Text style={styles.freeRotationValue}>{freeRotation.toFixed(1)}°</Text>
                            {freeRotation !== 0 && (
                                <TouchableOpacity onPress={() => setFreeRotation(0)} hitSlop={8}>
                                    <RotateCcw size={12} color="#6b7280" />
                                </TouchableOpacity>
                            )}
                        </View>

                        {/* Aspect ratio presets (shown when cropping) */}
                        {isCropping && (
                            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.aspectRow}>
                                {ASPECT_RATIOS.map(({ label, value }) => {
                                    const isActive = selectedAspectRatio === value;
                                    return (
                                        <TouchableOpacity
                                            key={label}
                                            onPress={() => handleAspectRatioChange(value)}
                                            style={[styles.aspectBtn, isActive && styles.aspectBtnActive]}
                                        >
                                            <Text style={[styles.aspectLabel, isActive && styles.aspectLabelActive]}>{label}</Text>
                                        </TouchableOpacity>
                                    );
                                })}
                            </ScrollView>
                        )}
                    </View>
                )}
                {activeTab === 'adjust' && (
                    <AdjustmentSliders adjustments={adjustments} onAdjustmentsChange={setAdjustments} />
                )}
                {activeTab === 'filter' && (
                    <FilterPresets
                        activeFilter={activeFilter}
                        filterIntensity={filterIntensity}
                        onFilterChange={handleFilterChange}
                        onIntensityChange={setFilterIntensity}
                        imageUri={imageUri}
                        previewImageUri={filterPreviewUri}
                        adjustmentsMatrix={adjustmentsMatrix}
                    />
                )}
                {activeTab === 'draw' && (
                    <DrawingControls
                        paths={drawPaths}
                        onPathsChange={setDrawPaths}
                        currentColor={drawColor}
                        onColorChange={setDrawColor}
                        currentStrokeWidth={drawStrokeWidth}
                        onStrokeWidthChange={setDrawStrokeWidth}
                        currentOpacity={drawOpacity}
                        onOpacityChange={setDrawOpacity}
                        currentTool={drawTool}
                        onToolChange={handleDrawToolChange}
                        isTextMode={drawSubMode === 'text'}
                        onTextPress={() => {
                            if (drawSubMode === 'text') {
                                handleAddNewText();
                            } else {
                                setDrawSubMode('text');
                                if (textItems.length === 0) {
                                    handleAddNewText();
                                }
                            }
                        }}
                    />
                )}
            </View>

            <EditToolbar activeTab={activeTab} onTabChange={handleTabChange} />

            <View style={styles.hiddenCaptureHost} pointerEvents="none" collapsable={false}>
                <ViewShot
                    ref={filterPreviewShotRef}
                    options={{ format: 'jpg', quality: 0.85 }}
                    style={{
                        width: captureSize.width,
                        height: captureSize.height,
                        justifyContent: 'center',
                        alignItems: 'center',
                        overflow: 'hidden',
                    }}
                >
                    {filterPreviewBaseImage}
                </ViewShot>
            </View>

            {/* Samsung-style full-screen text editor */}
            {editingTextId && imageUri && (() => {
                const editingItem = textItems.find(t => t.id === editingTextId);
                if (!editingItem) return null;
                return (
                    <TextEditorFullScreen
                        key={editingTextId}
                        item={editingItem}
                        otherItems={textItems.filter(t => t.id !== editingTextId && t.text.length > 0)}
                        imageUri={imageUri}
                        imageWidth={imageSize.width}
                        imageHeight={imageSize.height}
                        colorMatrix={colorMatrix}
                        imageTransform={imageTransform}
                        onDone={handleTextEditorCommit}
                    />
                );
            })()}
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: '#050505' },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#050505' },
    errorText: { fontSize: 15, color: '#737373', textAlign: 'center', marginBottom: 16 },
    goBackBtn: { backgroundColor: '#4f46e5', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 14 },
    goBackBtnText: { color: '#fff', fontWeight: '600', fontSize: 14 },

    topBar: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 8,
        paddingVertical: 6,
        backgroundColor: '#050505',
        gap: 4,
    },
    iconBtn: { padding: 8 },
    topBarCenter: { flex: 1, alignItems: 'center' },
    undoRedoRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    undoRedoBtn: {
        width: 34,
        height: 34,
        borderRadius: 11,
        backgroundColor: '#111',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: '#1a1a1a',
    },
    undoRedoBtnDisabled: {
        opacity: 0.2,
    },
    resetBtn: {
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: '#1a1a1a',
        backgroundColor: '#111',
        marginLeft: 4,
    },
    resetBtnText: { color: '#737373', fontSize: 10, fontWeight: '600' },
    cropActions: {
        flexDirection: 'row',
        gap: 10,
    },
    cropCancelBtn: {
        paddingHorizontal: 16,
        paddingVertical: 7,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: '#222',
        backgroundColor: '#111',
    },
    cropCancelText: { color: '#a3a3a3', fontSize: 12, fontWeight: '600' },
    cropApplyBtn: {
        paddingHorizontal: 16,
        paddingVertical: 7,
        borderRadius: 12,
        backgroundColor: '#4f46e5',
    },
    cropApplyText: { color: '#fff', fontSize: 12, fontWeight: '700' },
    saveBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        backgroundColor: '#4f46e5',
        paddingHorizontal: 16,
        paddingVertical: 9,
        borderRadius: 12,
    },
    saveBtnDisabled: { opacity: 0.2 },
    saveBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },

    imageContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: '#0a0a0a',
        overflow: 'hidden',
    },
    imageWrapper: { justifyContent: 'center', alignItems: 'center' },
    sceneSurface: {
        position: 'relative',
    },
    sceneImageLayer: {
        ...StyleSheet.absoluteFillObject,
        justifyContent: 'center',
        alignItems: 'center',
    },
    drawOverlay: {
        position: 'absolute',
        zIndex: 15,
    },
    interactiveOverlayFrame: {
        position: 'absolute',
        zIndex: 16,
    },
    cropOverlayContainer: {
        justifyContent: 'center',
        alignItems: 'center',
    },

    originalOverlay: {
        ...StyleSheet.absoluteFillObject,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: '#0a0a0a',
        zIndex: 10,
    },
    originalBadge: {
        position: 'absolute',
        top: 12,
        left: 12,
        backgroundColor: 'rgba(0,0,0,0.75)',
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 8,
        zIndex: 11,
    },
    originalBadgeText: {
        color: '#e5e5e5',
        fontSize: 9,
        fontWeight: '800',
        letterSpacing: 1.5,
    },

    toolPanel: {
        backgroundColor: '#050505',
        height: 160,
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderTopWidth: 1,
        borderTopColor: '#111',
    },
    hiddenCaptureHost: {
        position: 'absolute',
        left: 0,
        top: 0,
        opacity: 0,
    },

    // Transform panel
    transformPanel: {
        gap: 12,
    },
    transformRow: {
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 16,
    },
    transformBtn: { alignItems: 'center', gap: 5 },
    transformIcon: {
        width: 46,
        height: 46,
        borderRadius: 15,
        backgroundColor: '#111',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: '#1a1a1a',
    },
    transformIconActive: { borderColor: '#6366f1', backgroundColor: '#312e81' },
    transformLabel: { color: '#525252', fontSize: 10, fontWeight: '600' },
    transformLabelActive: { color: '#c7d2fe', fontWeight: '700' },

    // Free rotation
    freeRotationRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 4,
    },
    freeRotationSlider: {
        flex: 1,
        height: 28,
    },
    freeRotationValue: {
        fontSize: 11,
        color: '#818cf8',
        fontWeight: '700',
        fontVariant: ['tabular-nums'],
        width: 38,
        textAlign: 'right',
    },

    // Aspect ratios
    aspectRow: {
        gap: 6,
        paddingVertical: 4,
    },
    aspectBtn: {
        paddingHorizontal: 14,
        paddingVertical: 6,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: '#1a1a1a',
        backgroundColor: '#111',
    },
    aspectBtnActive: {
        borderColor: '#6366f1',
        backgroundColor: '#312e81',
    },
    aspectLabel: {
        color: '#525252',
        fontSize: 11,
        fontWeight: '600',
    },
    aspectLabelActive: {
        color: '#c7d2fe',
        fontWeight: '700',
    },

    // Draw sub-mode toggle
    subModeRow: {
        flexDirection: 'row',
        alignSelf: 'center',
        backgroundColor: '#111',
        borderRadius: 14,
        borderWidth: 1,
        borderColor: '#1a1a1a',
        padding: 3,
        gap: 2,
    },
    subModeBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 18,
        paddingVertical: 8,
        borderRadius: 11,
    },
    subModeBtnActive: {
        backgroundColor: '#4f46e5',
    },
    subModeLabel: {
        fontSize: 12,
        fontWeight: '600',
        color: '#6b7280',
    },
    subModeLabelActive: {
        color: '#fff',
    },
});
