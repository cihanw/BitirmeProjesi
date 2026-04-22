import React, { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import {
    Image as RNImage,
    Keyboard,
    LayoutAnimation,
    PanResponder,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    UIManager,
    View,
} from 'react-native';
import { AlignCenter, AlignLeft, AlignRight, Check, Trash2, Type, Copy, Palette } from 'lucide-react-native';
import Slider from '@react-native-community/slider';
import { ColorMatrix, type Matrix } from '@/src/lib/color-matrix-filters';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
    UIManager.setLayoutAnimationEnabledExperimental(true);
}

export type TextAlign = 'left' | 'center' | 'right';
export type TextStyle = 'plain' | 'outline' | 'box' | 'shadow';
export type FontWeight = 'normal' | 'light' | 'bold' | 'italic';

export type TextItem = {
    id: string;
    text: string;
    color: string;
    fontSize: number;
    x: number;
    y: number;
    rotation: number;
    scale: number;
    align: TextAlign;
    textStyle: TextStyle;
    fontWeight: FontWeight;
};

/* ── color presets ── */

const PRESET_COLORS = [
    '#ffffff', '#e0e0e0', '#9e9e9e', '#000000',
    '#f44336', '#e91e63', '#ff5722', '#ff9800',
    '#ffc107', '#ffeb3b', '#cddc39', '#8bc34a',
    '#4caf50', '#009688', '#00bcd4', '#03a9f4',
    '#2196f3', '#3f51b5', '#673ab7', '#9c27b0',
    '#795548', '#607d8b',
];

function hslToHex(h: number, s: number, l: number): string {
    s /= 100; l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => {
        const k = (n + h / 30) % 12;
        const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
        return Math.round(255 * c).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}

const HUES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
const PALETTE_GRID: string[][] = [
    ['#ffffff', '#e0e0e0', '#bdbdbd', '#9e9e9e', '#757575', '#616161', '#424242', '#303030', '#212121', '#000000'],
    HUES.map(h => hslToHex(h, 100, 80)),
    HUES.map(h => hslToHex(h, 100, 60)),
    HUES.map(h => hslToHex(h, 100, 45)),
    HUES.map(h => hslToHex(h, 100, 30)),
    HUES.map(h => hslToHex(h, 50, 55)),
];

let nextId = 0;

/* ── helpers ── */

type InteractionState = {
    type: 'drag' | 'pinch';
    id: string;
    startX: number;
    startY: number;
    origItem: TextItem;
    initialDist?: number;
    initialAngle?: number;
    moved: boolean;
} | null;

function estimateTextSize(item: TextItem) {
    const eff = item.fontSize * item.scale;
    const w = Math.max(item.text.length * eff * 0.52, 50);
    const h = eff * 1.3;
    return { w, h };
}

function getTouchDist(touches: any[]) {
    const dx = touches[0].pageX - touches[1].pageX;
    const dy = touches[0].pageY - touches[1].pageY;
    return Math.sqrt(dx * dx + dy * dy);
}

function getTouchAngle(touches: any[]) {
    return Math.atan2(touches[1].pageY - touches[0].pageY, touches[1].pageX - touches[0].pageX);
}

export function createTextItem(color: string, fontSize: number, containerW: number, containerH: number, offset = 0): TextItem {
    return {
        id: `text_${nextId++}`, text: '', color, fontSize,
        x: containerW * 0.5, y: containerH * 0.15 + offset * 40,
        rotation: 0, scale: 1, align: 'center',
        textStyle: 'plain', fontWeight: 'bold',
    };
}

export function getTextItemStyle(item: TextItem) {
    const base: any = {
        color: item.color,
        fontSize: item.fontSize * (item.scale || 1),
        textAlign: item.align || 'center',
        fontWeight: item.fontWeight === 'bold' ? '700' : item.fontWeight === 'light' ? '300' : '400',
        fontStyle: item.fontWeight === 'italic' ? 'italic' : 'normal',
    };
    switch (item.textStyle) {
        case 'outline':
            base.textShadowColor = item.color;
            base.textShadowOffset = { width: 0, height: 0 };
            base.textShadowRadius = 2;
            base.color = 'transparent';
            break;
        case 'shadow':
            base.textShadowColor = 'rgba(0,0,0,0.8)';
            base.textShadowOffset = { width: 2, height: 2 };
            base.textShadowRadius = 6;
            break;
        case 'box':
        case 'plain':
        default:
            base.textShadowColor = 'rgba(0,0,0,0.6)';
            base.textShadowOffset = { width: 1, height: 1 };
            base.textShadowRadius = 3;
            break;
    }
    return base;
}

export function getTextBoxStyle(item: TextItem) {
    if (item.textStyle !== 'box') return null;
    return {
        backgroundColor: item.color === '#000000' ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.55)',
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 6,
    };
}

/* ═══════════════════════════════════════════════════════════════
   TextOnCanvas — drag/select/pinch layer on the photo
   ═══════════════════════════════════════════════════════════════ */

type TextOnCanvasProps = {
    textItems: TextItem[];
    onTextItemsChange: (items: TextItem[]) => void;
    selectedItemId: string | null;
    onSelectItem: (id: string | null) => void;
    onStartEditing: (id: string) => void;
    sceneWidth: number;
    sceneHeight: number;
    viewportWidth: number;
    viewportHeight: number;
    viewportScale?: number;
    viewportOffsetX?: number;
    viewportOffsetY?: number;
    allowedLeft?: number;
    allowedTop?: number;
    allowedRight?: number;
    allowedBottom?: number;
};

export function TextOnCanvas({
    textItems, onTextItemsChange, selectedItemId, onSelectItem,
    onStartEditing, sceneWidth, sceneHeight,
    viewportWidth, viewportHeight,
    viewportScale = 1, viewportOffsetX = 0, viewportOffsetY = 0,
    allowedLeft = 0, allowedTop = 0, allowedRight = sceneWidth, allowedBottom = sceneHeight,
}: TextOnCanvasProps) {
    const interactionRef = useRef<InteractionState>(null);
    const stateRef = useRef({
        textItems,
        selectedItemId,
        onSelectItem,
        onStartEditing,
        onTextItemsChange,
        sceneWidth,
        sceneHeight,
        viewportWidth,
        viewportHeight,
        viewportScale,
        viewportOffsetX,
        viewportOffsetY,
        allowedLeft,
        allowedTop,
        allowedRight,
        allowedBottom,
    });
    stateRef.current = {
        textItems,
        selectedItemId,
        onSelectItem,
        onStartEditing,
        onTextItemsChange,
        sceneWidth,
        sceneHeight,
        viewportWidth,
        viewportHeight,
        viewportScale,
        viewportOffsetX,
        viewportOffsetY,
        allowedLeft,
        allowedTop,
        allowedRight,
        allowedBottom,
    };

    const panResponder = useMemo(() => PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,

        onPanResponderGrant: (e) => {
            const { textItems: items, selectedItemId: selId, onSelectItem: onSel } = stateRef.current;
            // locationX/Y for hit testing (reliable on initial touch inside container)
            const lx = e.nativeEvent.locationX;
            const ly = e.nativeEvent.locationY;
            const scale = Math.max(stateRef.current.viewportScale, 0.0001);
            const sceneX = (lx - stateRef.current.viewportOffsetX) / scale;
            const sceneY = (ly - stateRef.current.viewportOffsetY) / scale;
            // pageX/Y for drag delta (reliable even outside container bounds)
            const px = e.nativeEvent.pageX;
            const py = e.nativeEvent.pageY;
            let hitId: string | null = null;
            for (const item of items) {
                const { w, h } = estimateTextSize(item);
                if (sceneX >= item.x - 12 && sceneX <= item.x + w + 12 && sceneY >= item.y - 12 && sceneY <= item.y + h + 12) {
                    hitId = item.id; break;
                }
            }
            if (hitId) {
                const item = items.find(t => t.id === hitId)!;
                if (hitId !== selId) onSel(hitId);
                interactionRef.current = { type: 'drag', id: hitId, startX: px, startY: py, origItem: { ...item }, moved: false };
            } else { onSel(null); }
        },

        onPanResponderStart: (e) => {
            // Additional finger touched — switch to pinch if we have a selected item
            const { textItems: items, selectedItemId: selId } = stateRef.current;
            const touches = e.nativeEvent.touches;
            if (touches && touches.length >= 2 && selId) {
                const sel = items.find(t => t.id === selId);
                if (sel) {
                    interactionRef.current = {
                        type: 'pinch', id: selId, startX: 0, startY: 0,
                        origItem: { ...sel }, initialDist: getTouchDist(touches),
                        initialAngle: getTouchAngle(touches), moved: true,
                    };
                }
            }
        },

        onPanResponderMove: (e) => {
            const ref = interactionRef.current;
            if (!ref) return;
            const {
                textItems: items,
                onTextItemsChange: onChange,
                sceneWidth: cw,
                sceneHeight: ch,
                viewportScale: scale,
                allowedLeft: minX,
                allowedTop: minY,
                allowedRight: maxX,
                allowedBottom: maxY,
            } = stateRef.current;
            const touches = e.nativeEvent.touches;

            // Pinch: scale + rotate
            if (touches && touches.length >= 2 && ref.type === 'pinch') {
                const dist = getTouchDist(touches);
                const angle = getTouchAngle(touches);
                const newScale = Math.max(0.3, Math.min(5, ref.origItem.scale * (dist / (ref.initialDist || 1))));
                const newRot = ref.origItem.rotation + (angle - (ref.initialAngle || 0)) * (180 / Math.PI);
                onChange(items.map(t => t.id === ref.id ? { ...t, scale: newScale, rotation: newRot } : t));
                return;
            }
            // Drag → pinch transition
            if (touches && touches.length >= 2 && ref.type === 'drag') {
                const item = items.find(t => t.id === ref.id);
                if (item) {
                    interactionRef.current = {
                        type: 'pinch', id: ref.id, startX: 0, startY: 0,
                        origItem: { ...item },
                        initialDist: getTouchDist(touches), initialAngle: getTouchAngle(touches), moved: true,
                    };
                }
                return;
            }
            // Single-finger drag using pageX/Y (no wrap-around on Android)
            const px = e.nativeEvent.pageX; const py = e.nativeEvent.pageY;
            const dx = (px - ref.startX) / Math.max(scale, 0.0001);
            const dy = (py - ref.startY) / Math.max(scale, 0.0001);
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) ref.moved = true;
            if (ref.type === 'drag') {
                const { w: tw, h: th } = estimateTextSize(ref.origItem);
                const leftBound = Math.max(-tw * 0.5, minX);
                const rightBound = Math.min(cw - tw * 0.5, maxX - tw);
                const topBound = Math.max(0, minY);
                const bottomBound = Math.min(ch - th, maxY - th);
                const newX = Math.max(leftBound, Math.min(rightBound, ref.origItem.x + dx));
                const newY = Math.max(topBound, Math.min(bottomBound, ref.origItem.y + dy));
                onChange(items.map(t => t.id === ref.id ? { ...t, x: newX, y: newY } : t));
            }
        },

        onPanResponderRelease: () => {
            const ref = interactionRef.current;
            const { selectedItemId: selId, onStartEditing: onEdit } = stateRef.current;
            if (ref && !ref.moved && ref.type === 'drag' && ref.id === selId) {
                onEdit(ref.id);
            }
            interactionRef.current = null;
        },
    }), []);

    const selectedItem = selectedItemId ? textItems.find(t => t.id === selectedItemId) : null;

    const handleDelete = useCallback(() => {
        if (!selectedItemId) return;
        onTextItemsChange(textItems.filter(t => t.id !== selectedItemId));
        onSelectItem(null);
    }, [selectedItemId, textItems, onTextItemsChange, onSelectItem]);

    const handleDuplicate = useCallback(() => {
        if (!selectedItemId) return;
        const sel = textItems.find(t => t.id === selectedItemId);
        if (!sel) return;
        const { w, h } = estimateTextSize(sel);
        const leftBound = Math.max(-w * 0.5, allowedLeft);
        const rightBound = Math.min(sceneWidth - w * 0.5, allowedRight - w);
        const topBound = Math.max(0, allowedTop);
        const bottomBound = Math.min(sceneHeight - h, allowedBottom - h);
        const dup: TextItem = {
            ...sel,
            id: `text_${nextId++}`,
            x: Math.max(leftBound, Math.min(rightBound, sel.x + 20)),
            y: Math.max(topBound, Math.min(bottomBound, sel.y + 20)),
        };
        onTextItemsChange([...textItems, dup]);
        onSelectItem(dup.id);
    }, [selectedItemId, textItems, onTextItemsChange, onSelectItem, allowedLeft, allowedTop, allowedRight, allowedBottom, sceneWidth, sceneHeight]);

    return (
        <View
            style={{ position: 'absolute', width: viewportWidth, height: viewportHeight, zIndex: 15 }}
            pointerEvents="box-none"
        >
            {/* Action buttons — rendered OUTSIDE PanResponder so they receive taps */}
            {selectedItem && (() => {
                const { w } = estimateTextSize(selectedItem);
                const scale = Math.max(viewportScale, 0.0001);
                const boxX = viewportOffsetX + selectedItem.x * scale;
                const boxY = viewportOffsetY + selectedItem.y * scale;
                const boxW = w * scale;
                return (
                    <View style={{
                        position: 'absolute', left: boxX + boxW / 2 - 50, top: boxY - 52,
                        width: 100, flexDirection: 'row', justifyContent: 'center', gap: 4, zIndex: 30,
                    }}>
                        <TouchableOpacity onPress={handleDuplicate} style={floatS.bubbleBtn} hitSlop={8}>
                            <Copy size={16} color="#fff" />
                        </TouchableOpacity>
                        <TouchableOpacity onPress={handleDelete} style={floatS.bubbleBtn} hitSlop={8}>
                            <Trash2 size={16} color="#f87171" />
                        </TouchableOpacity>
                    </View>
                );
            })()}
            {/* PanResponder touch area */}
            <View
                style={{ position: 'absolute', width: viewportWidth, height: viewportHeight }}
                {...panResponder.panHandlers}
            >
            {selectedItem && (() => {
                const { w, h } = estimateTextSize(selectedItem);
                const scale = Math.max(viewportScale, 0.0001);
                const boxX = viewportOffsetX + selectedItem.x * scale;
                const boxY = viewportOffsetY + selectedItem.y * scale;
                const boxW = w * scale;
                const boxH = h * scale;
                return (
                    <>
                        <View style={{
                            position: 'absolute', left: boxX - 8, top: boxY - 6,
                            width: boxW + 16, height: boxH + 12,
                            borderWidth: 1.5, borderColor: '#818cf8', borderRadius: 6, borderStyle: 'dashed',
                            transform: [{ rotate: `${selectedItem.rotation}deg` }],
                        }} pointerEvents="none">
                            {[[0, 0], [1, 0], [0, 1], [1, 1]].map(([cx, cy], i) => (
                                <View key={i} style={{
                                    position: 'absolute', left: cx ? '100%' : -5, top: cy ? '100%' : -5,
                                    marginLeft: cx ? -5 : 0, marginTop: cy ? -5 : 0,
                                    width: 10, height: 10, borderRadius: 5, backgroundColor: '#818cf8',
                                }} />
                            ))}
                        </View>
                    </>
                );
            })()}
            </View>{/* end PanResponder */}
        </View>
    );
}

/* ═══════════════════════════════════════════════════════════════
   TextEditorFullScreen — Samsung Galaxy style full-screen text editor

   Layout (pure flex, NO absolute positioning for controls):
     1. Top bar (Tamam button)
     2. Photo + text overlay  (flex: 1, shrinks naturally)
     3. Contextual panel      (if a tab is active — between photo & toolbar)
     4. Main toolbar           (always at the very bottom)

   Keyboard: Android adjustResize alone is not enough for this absolute-positioned
   modal. Manual keyboardHeight tracking + paddingBottom is used to keep the
   bottom toolbar (color picker, font options) visible above the keyboard.
   ═══════════════════════════════════════════════════════════════ */

type ToolPanel = 'none' | 'font' | 'color' | 'style';

const FONT_WEIGHTS: { key: FontWeight; label: string; style: any }[] = [
    { key: 'normal', label: 'Aa', style: { fontWeight: '400' } },
    { key: 'light', label: 'Aa', style: { fontWeight: '300', opacity: 0.7 } },
    { key: 'bold', label: 'Aa', style: { fontWeight: '800' } },
    { key: 'italic', label: 'Aa', style: { fontWeight: '400', fontStyle: 'italic' } },
];

const TEXT_STYLES: { key: TextStyle; label: string }[] = [
    { key: 'plain', label: 'Düz' },
    { key: 'box', label: 'Kutu' },
    { key: 'shadow', label: 'Gölge' },
    { key: 'outline', label: 'Hat' },
];

type TextEditorFullScreenProps = {
    item: TextItem;
    otherItems?: TextItem[];
    imageUri: string;
    imageWidth: number;
    imageHeight: number;
    colorMatrix?: Matrix | null;
    imageTransform?: any[];
    onDone: (id: string, text: string, updates: Partial<TextItem>) => void;
};

export const TextEditorFullScreen = memo(function TextEditorFullScreen({
    item, otherItems, imageUri, imageWidth, imageHeight, colorMatrix: cMatrix, imageTransform, onDone,
}: TextEditorFullScreenProps) {
    const insets = useSafeAreaInsets();
    const [text, setText] = useState(item.text);
    const [fontSize, setFontSize] = useState(item.fontSize);
    const [color, setColor] = useState(item.color);
    const [align, setAlign] = useState<TextAlign>(item.align || 'center');
    const [textStyle, setTextStyle] = useState<TextStyle>(item.textStyle || 'plain');
    const [fontWeight, setFontWeight] = useState<FontWeight>(item.fontWeight || 'bold');
    const [activePanel, setActivePanel] = useState<ToolPanel>('none');
    const [colorPickerOpen, setColorPickerOpen] = useState(false);
    const [middleSize, setMiddleSize] = useState({ width: 0, height: 0 });
    const [keyboardHeight, setKeyboardHeight] = useState(0);
    const inputRef = useRef<TextInput>(null);

    const refocus = useCallback(() => {
        setTimeout(() => inputRef.current?.focus(), 50);
    }, []);

    useEffect(() => {
        const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
        const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
        const showSub = Keyboard.addListener(showEvent, (e) => setKeyboardHeight(e.endCoordinates.height));
        const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardHeight(0));
        return () => { showSub.remove(); hideSub.remove(); };
    }, []);

    const finish = useCallback(() => {
        onDone(item.id, text, { fontSize, color, align, textStyle, fontWeight });
    }, [item.id, text, fontSize, color, align, textStyle, fontWeight, onDone]);

    const cycleAlign = useCallback(() => {
        setAlign(a => a === 'left' ? 'center' : a === 'center' ? 'right' : 'left');
        refocus();
    }, [refocus]);

    const togglePanel = useCallback((panel: ToolPanel) => {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setActivePanel(p => p === panel ? 'none' : panel);
        setColorPickerOpen(false);
        refocus();
    }, [refocus]);

    const selectColor = useCallback((c: string) => {
        setColor(c);
        refocus();
    }, [refocus]);

    const openPalette = useCallback(() => {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setColorPickerOpen(true);
        refocus();
    }, [refocus]);

    const closePalette = useCallback(() => {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setColorPickerOpen(false);
        refocus();
    }, [refocus]);

    const AlignIcon = align === 'left' ? AlignLeft : align === 'right' ? AlignRight : AlignCenter;
    const photoAspect = (imageWidth || 1) / (imageHeight || 1);

    const onMiddleLayout = useCallback((e: any) => {
        const { width, height } = e.nativeEvent.layout;
        setMiddleSize(prev => (prev.width === width && prev.height === height) ? prev : { width, height });
    }, []);

    const photoDisplaySize = useMemo(() => {
        const cw = middleSize.width || 300;
        const ch = middleSize.height || 400;
        const containerAspect = cw / ch;
        if (photoAspect > containerAspect) {
            // Photo is wider than container — fit to width
            return { width: cw, height: cw / photoAspect };
        } else {
            // Photo is taller than container — fit to height
            return { width: ch * photoAspect, height: ch };
        }
    }, [middleSize, photoAspect]);

    const previewStyle: any = {
        color: textStyle === 'outline' ? 'transparent' : color,
        fontSize,
        textAlign: align,
        fontWeight: fontWeight === 'bold' ? '700' : fontWeight === 'light' ? '300' : '400',
        fontStyle: fontWeight === 'italic' ? 'italic' : 'normal',
        textShadowColor: textStyle === 'shadow' ? 'rgba(0,0,0,0.8)' : textStyle === 'outline' ? color : 'rgba(0,0,0,0.6)',
        textShadowOffset: textStyle === 'shadow' ? { width: 2, height: 2 } : { width: 1, height: 1 },
        textShadowRadius: textStyle === 'shadow' ? 6 : textStyle === 'outline' ? 2 : 3,
        width: '100%',
        padding: 0,
    };

    const isDark = (c: string) => {
        const hex = c.replace('#', '');
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);
        return (r * 0.299 + g * 0.587 + b * 0.114) < 140;
    };

    return (
        <View style={[ed.root, { paddingBottom: keyboardHeight || 14 }]}>
            {/* ─── 1. TOP BAR ─── */}
            <View style={[ed.topRow, { paddingTop: insets.top + 4 }]}>
                <Pressable style={{ flex: 1 }} onPress={finish} />
                <TouchableOpacity onPress={finish} hitSlop={16} activeOpacity={0.7}>
                    <Text style={ed.okText}>Okey</Text>
                </TouchableOpacity>
            </View>

            {/* ─── 2. PHOTO + TEXT (flex:1 — shrinks when keyboard/panels appear) ─── */}
            <Pressable style={ed.middle} onLayout={onMiddleLayout} onPress={finish}>
                <View style={{ width: photoDisplaySize.width, height: photoDisplaySize.height }}>
                    {cMatrix ? (
                        <ColorMatrix matrix={cMatrix}>
                            <RNImage
                                source={{ uri: imageUri }}
                                style={{ width: '100%', height: '100%', borderRadius: 6, opacity: 0.5, ...(imageTransform ? { transform: imageTransform } : {}) }}
                                resizeMode="cover"
                            />
                        </ColorMatrix>
                    ) : (
                        <RNImage
                            source={{ uri: imageUri }}
                            style={{ width: '100%', height: '100%', borderRadius: 6, opacity: 0.5, ...(imageTransform ? { transform: imageTransform } : {}) }}
                            resizeMode="cover"
                        />
                    )}
                    {/* Render other existing text items on the photo */}
                    {otherItems && otherItems.map((ot) => (
                        <Text
                            key={ot.id}
                            style={[
                                getTextItemStyle(ot),
                                {
                                    position: 'absolute',
                                    left: ot.x, top: ot.y,
                                    transform: [{ rotate: `${ot.rotation}deg` }],
                                },
                                getTextBoxStyle(ot),
                            ]}
                        >
                            {ot.text}
                        </Text>
                    ))}
                    <View style={ed.textOverlay}>
                        <TextInput
                            ref={inputRef}
                            style={previewStyle}
                            value={text}
                            onChangeText={setText}
                            autoFocus
                            placeholder=""
                            multiline
                            textAlignVertical="center"
                            cursorColor={color}
                            selectionColor={color + '44'}
                        />
                    </View>
                    <View style={ed.sliderOverlay} pointerEvents="box-none">
                        <View style={ed.sliderInner}>
                            <Slider
                                style={{ width: 200, height: 36 }}
                                minimumValue={14}
                                maximumValue={80}
                                step={1}
                                value={fontSize}
                                onValueChange={setFontSize}
                                minimumTrackTintColor="rgba(255,255,255,0.7)"
                                maximumTrackTintColor="rgba(255,255,255,0.2)"
                                thumbTintColor="#fff"
                            />
                        </View>
                    </View>
                </View>
            </Pressable>

            {/* ─── 3. BOTTOM ZONE ─── */}
            <ScrollView style={ed.bottomZone} keyboardShouldPersistTaps="always" scrollEnabled={false}>

            {activePanel === 'font' && (
                <View style={ed.panelCard}>
                    <View style={ed.chipRow}>
                        {FONT_WEIGHTS.map((fw) => (
                            <TouchableOpacity
                                key={fw.key}
                                onPress={() => { setFontWeight(fw.key); refocus(); }}
                                style={[ed.chip, fontWeight === fw.key && ed.chipActive]}
                            >
                                <Text style={[ed.chipText, fw.style, fontWeight === fw.key && ed.chipTextActive]}>
                                    {fw.label}
                                </Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                </View>
            )}

            {activePanel === 'color' && !colorPickerOpen && (
                <View style={ed.panelCard}>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={ed.colorRow}>
                        {PRESET_COLORS.map((c) => (
                            <TouchableOpacity
                                key={c}
                                onPress={() => selectColor(c)}
                                style={[ed.colorCircle, { backgroundColor: c }, color === c && ed.colorCircleActive]}
                            >
                                {color === c && <Check size={13} color={isDark(c) ? '#fff' : '#000'} />}
                            </TouchableOpacity>
                        ))}
                        <TouchableOpacity onPress={openPalette} style={ed.paletteBtn}>
                            <Palette size={18} color="#fff" />
                        </TouchableOpacity>
                    </ScrollView>
                </View>
            )}

            {activePanel === 'color' && colorPickerOpen && (
                <View style={ed.panelCard}>
                    <View style={ed.paletteHeader}>
                        <Text style={ed.panelLabel}>Renk Paleti</Text>
                        <TouchableOpacity onPress={closePalette} hitSlop={8}>
                            <Text style={ed.paletteBack}>{'← Geri'}</Text>
                        </TouchableOpacity>
                    </View>
                    {PALETTE_GRID.map((row, ri) => (
                        <View key={ri} style={ed.paletteRow}>
                            {row.map((c, ci) => (
                                <TouchableOpacity
                                    key={`${ri}-${ci}`}
                                    onPress={() => selectColor(c)}
                                    style={[
                                        ed.paletteCell,
                                        { backgroundColor: c },
                                        color === c && ed.paletteCellActive,
                                    ]}
                                >
                                    {color === c && <Check size={10} color={isDark(c) ? '#fff' : '#000'} />}
                                </TouchableOpacity>
                            ))}
                        </View>
                    ))}
                </View>
            )}

            {activePanel === 'style' && (
                <View style={ed.panelCard}>
                    <View style={ed.chipRow}>
                        {TEXT_STYLES.map((ts) => (
                            <TouchableOpacity
                                key={ts.key}
                                onPress={() => { setTextStyle(ts.key); refocus(); }}
                                style={[ed.chip, textStyle === ts.key && ed.chipActive]}
                            >
                                <Text style={[ed.chipText, textStyle === ts.key && ed.chipTextActive]}>
                                    {ts.label}
                                </Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                </View>
            )}

            {/* ─── 4. MAIN TOOLBAR (always at the very bottom) ─── */}
            <View style={ed.toolRow}>
                <TouchableOpacity onPress={cycleAlign} style={ed.toolBtn} hitSlop={6}>
                    <AlignIcon size={22} color="#fff" />
                </TouchableOpacity>
                <TouchableOpacity
                    onPress={() => togglePanel('font')}
                    style={[ed.toolBtn, activePanel === 'font' && ed.toolBtnActive]}
                    hitSlop={6}
                >
                    <Text style={[ed.aaLabel, activePanel === 'font' && { color: '#000' }]}>Aa</Text>
                </TouchableOpacity>
                <TouchableOpacity
                    onPress={() => togglePanel('color')}
                    style={[ed.toolBtn, activePanel === 'color' && ed.toolBtnActive]}
                    hitSlop={6}
                >
                    <View style={[ed.colorDot, { backgroundColor: color }]} />
                </TouchableOpacity>
                <TouchableOpacity
                    onPress={() => togglePanel('style')}
                    style={[ed.toolBtn, activePanel === 'style' && ed.toolBtnActive]}
                    hitSlop={6}
                >
                    <Type size={22} color={activePanel === 'style' ? '#000' : '#fff'} />
                </TouchableOpacity>
            </View>

            </ScrollView>{/* end bottomZone */}
        </View>
    );
});

/* ═══════════════════════════════════════════════════════════════
   TextToolbar
   ═══════════════════════════════════════════════════════════════ */

type TextToolbarProps = { textItems: TextItem[] };

export function TextToolbar({ textItems }: TextToolbarProps) {
    return <View style={tb.container} />;
}

/* ══════════════════════════════════════════════════════════════
   Styles
   ══════════════════════════════════════════════════════════════ */

const floatS = StyleSheet.create({
    bubbleBtn: {
        width: 40, height: 36, borderRadius: 12,
        backgroundColor: 'rgba(30,30,30,0.92)',
        alignItems: 'center', justifyContent: 'center',
        borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
    },
});

const ed = StyleSheet.create({
    root: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: '#000',
        zIndex: 200,
        flexDirection: 'column',
    },

    topRow: {
        flexDirection: 'row', alignItems: 'center',
        paddingHorizontal: 20, paddingTop: 6, paddingBottom: 2,
    },
    okText: { color: '#fff', fontSize: 18, fontWeight: '700' },

    middle: {
        flex: 1,
        justifyContent: 'center', alignItems: 'center',
        minHeight: 80,
    },
    textOverlay: {
        ...StyleSheet.absoluteFillObject,
        justifyContent: 'center', alignItems: 'center',
        paddingHorizontal: 16,
    },
    sliderOverlay: {
        position: 'absolute', left: 0, top: 0, bottom: 0,
        width: 44, justifyContent: 'center', alignItems: 'center',
        zIndex: 10,
    },
    sliderInner: { transform: [{ rotate: '-90deg' }], width: 200, height: 36 },

    /* bottom zone — auto-sizes to content, sits at bottom */
    bottomZone: {
        flexGrow: 0,
        flexShrink: 0,
    },

    /* contextual panel card — between photo and toolbar */
    panelCard: {
        marginHorizontal: 10,
        marginBottom: 2,
        backgroundColor: 'rgba(30,30,30,0.95)',
        borderRadius: 16,
        paddingVertical: 6,
        paddingHorizontal: 12,
    },
    panelLabel: {
        color: 'rgba(255,255,255,0.45)', fontSize: 11,
        fontWeight: '600', marginBottom: 6, marginLeft: 2,
    },

    /* main toolbar — always at the very bottom */
    toolRow: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
        gap: 6,
        paddingVertical: 8, paddingHorizontal: 20,
        backgroundColor: 'rgba(30,30,30,0.95)',
        borderRadius: 18,
        marginHorizontal: 18,
        marginBottom: 4,
    },
    toolBtn: {
        width: 56, height: 46, alignItems: 'center', justifyContent: 'center',
        borderRadius: 14,
    },
    toolBtnActive: { backgroundColor: 'rgba(255,255,255,0.92)' },
    aaLabel: { color: '#fff', fontSize: 20, fontWeight: '700' },
    colorDot: {
        width: 26, height: 26, borderRadius: 13,
        borderWidth: 2.5, borderColor: '#fff',
    },

    /* chip buttons */
    chipRow: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
        gap: 8, flexWrap: 'wrap',
    },
    chip: {
        paddingHorizontal: 20, paddingVertical: 11, borderRadius: 22,
        backgroundColor: 'rgba(255,255,255,0.08)',
        borderWidth: 1.5, borderColor: 'transparent',
    },
    chipActive: { backgroundColor: '#fff', borderColor: '#fff' },
    chipText: { color: '#fff', fontSize: 16, fontWeight: '500' },
    chipTextActive: { color: '#000' },

    /* color row */
    colorRow: {
        gap: 10, paddingHorizontal: 2, paddingVertical: 4,
        alignItems: 'center',
    },
    colorCircle: {
        width: 32, height: 32, borderRadius: 16,
        borderWidth: 2, borderColor: 'transparent',
        alignItems: 'center', justifyContent: 'center',
    },
    colorCircleActive: { borderColor: '#fff', borderWidth: 3 },
    paletteBtn: {
        width: 32, height: 32, borderRadius: 16,
        backgroundColor: 'rgba(255,255,255,0.1)',
        alignItems: 'center', justifyContent: 'center',
        borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.25)',
    },

    /* full palette */
    paletteHeader: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 8, paddingHorizontal: 2,
    },
    paletteBack: { color: '#818cf8', fontSize: 13, fontWeight: '600' },
    paletteRow: {
        flexDirection: 'row', justifyContent: 'center', gap: 3, marginBottom: 3,
    },
    paletteCell: {
        flex: 1, maxWidth: 28, height: 24, borderRadius: 5,
        alignItems: 'center', justifyContent: 'center',
    },
    paletteCellActive: { borderWidth: 2, borderColor: '#fff' },
});

const tb = StyleSheet.create({
    container: { gap: 10 },
    hint: { fontSize: 12, color: '#505050', textAlign: 'center' },
});
