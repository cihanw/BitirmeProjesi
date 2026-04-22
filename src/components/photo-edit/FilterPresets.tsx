import { useCallback, useMemo, useState } from 'react';
import { ScrollView, Image as RNImage, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Slider from '@react-native-community/slider';
import {
    ColorMatrix,
    concatColorMatrices,
    normal,
    grayscale,
    sepia,
    saturate,
    warm,
    cool,
    kodachrome,
    vintage,
} from '@/src/lib/color-matrix-filters';

export type FilterPreset = 'original' | 'bw' | 'sepia' | 'vivid' | 'warm' | 'cool' | 'kodachrome' | 'vintage';

export const FILTER_MATRICES: Record<FilterPreset, ReturnType<typeof normal>> = {
    original: normal(),
    bw: grayscale(),
    sepia: sepia(),
    vivid: saturate(1.8),
    warm: warm(),
    cool: cool(),
    kodachrome: kodachrome(),
    vintage: vintage(),
};

const FILTERS: { key: FilterPreset; label: string }[] = [
    { key: 'original', label: 'Original' },
    { key: 'bw', label: 'B&W' },
    { key: 'sepia', label: 'Sepia' },
    { key: 'vivid', label: 'Vivid' },
    { key: 'warm', label: 'Warm' },
    { key: 'cool', label: 'Cool' },
    { key: 'kodachrome', label: 'Kodak' },
    { key: 'vintage', label: 'Vintage' },
];

const IDENTITY: number[] = [
    1, 0, 0, 0, 0,
    0, 1, 0, 0, 0,
    0, 0, 1, 0, 0,
    0, 0, 0, 1, 0,
];

export function interpolateMatrix(filterMatrix: number[], intensity: number): number[] {
    if (intensity >= 1) return filterMatrix;
    if (intensity <= 0) return IDENTITY;
    return IDENTITY.map((id, i) => id + (filterMatrix[i] - id) * intensity);
}

type Props = {
    activeFilter: FilterPreset;
    filterIntensity: number;
    onFilterChange: (filter: FilterPreset) => void;
    onIntensityChange: (intensity: number) => void;
    imageUri: string;
    previewImageUri?: string | null;
    adjustmentsMatrix?: number[] | null;
};

export function FilterPresets({ activeFilter, filterIntensity, onFilterChange, onIntensityChange, imageUri, previewImageUri, adjustmentsMatrix }: Props) {
    const showIntensity = activeFilter !== 'original';
    const sourceUri = previewImageUri || imageUri;
    const hasCapturedPreview = Boolean(previewImageUri);
    const [thumbImageLoaded, setThumbImageLoaded] = useState(false);
    const prevSourceRef = useMemo(() => ({ uri: '' }), []);
    if (prevSourceRef.uri !== sourceUri) {
        prevSourceRef.uri = sourceUri;
        if (thumbImageLoaded) setThumbImageLoaded(false);
    }
    const handleThumbLoad = useCallback(() => { if (!thumbImageLoaded) setThumbImageLoaded(true); }, [thumbImageLoaded]);

    // When we have a captured preview (edited photo snapshot), just apply the filter matrix on top
    // When no preview, apply adjustments + filter combined on the original imageUri
    const thumbMatrices = useMemo(() => {
        const result: Record<string, number[] | null> = {};
        for (const { key } of FILTERS) {
            const filterMat = [...FILTER_MATRICES[key]] as number[];
            const isIdentityFilter = key === 'original';
            if (hasCapturedPreview) {
                // Preview already has adjustments baked in — just apply filter
                result[key] = isIdentityFilter ? null : filterMat;
            } else if (adjustmentsMatrix && !isIdentityFilter) {
                result[key] = concatColorMatrices(adjustmentsMatrix as any, filterMat as any) as unknown as number[];
            } else if (adjustmentsMatrix && isIdentityFilter) {
                result[key] = adjustmentsMatrix as number[];
            } else if (!isIdentityFilter) {
                result[key] = filterMat;
            } else {
                result[key] = null;
            }
        }
        return result;
    }, [adjustmentsMatrix, hasCapturedPreview]);

    return (
        <View style={styles.wrapper}>
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.scrollContent}
            >
                {FILTERS.map(({ key, label }) => {
                    const isActive = activeFilter === key;
                    return (
                        <TouchableOpacity
                            key={key}
                            onPress={() => onFilterChange(key)}
                            style={styles.item}
                            activeOpacity={0.7}
                        >
                            <View style={[styles.thumbnail, isActive && styles.thumbnailActive]}>
                                {thumbMatrices[key] ? (
                                    <ColorMatrix key={`${key}-${thumbImageLoaded}`} matrix={thumbMatrices[key] as any}>
                                        <RNImage
                                            source={{ uri: sourceUri }}
                                            style={styles.thumbImage}
                                            resizeMode="cover"
                                            onLoad={handleThumbLoad}
                                        />
                                    </ColorMatrix>
                                ) : (
                                    <RNImage
                                        source={{ uri: sourceUri }}
                                        style={styles.thumbImage}
                                        resizeMode="cover"
                                        onLoad={handleThumbLoad}
                                    />
                                )}
                                {isActive && key !== 'original' && (
                                    <View style={styles.activeBadge}>
                                        <View style={styles.activeDot} />
                                    </View>
                                )}
                            </View>
                            <Text style={[styles.label, isActive && styles.labelActive]}>
                                {label}
                            </Text>
                        </TouchableOpacity>
                    );
                })}
            </ScrollView>

            {showIntensity && (
                <View style={styles.intensityRow}>
                    <Text style={styles.intensityLabel}>Intensity</Text>
                    <Slider
                        style={styles.intensitySlider}
                        minimumValue={0}
                        maximumValue={1}
                        step={0.01}
                        value={filterIntensity}
                        onValueChange={onIntensityChange}
                        minimumTrackTintColor="#6366f1"
                        maximumTrackTintColor="#1a1a1a"
                        thumbTintColor="#818cf8"
                    />
                    <Text style={styles.intensityValue}>{Math.round(filterIntensity * 100)}%</Text>
                </View>
            )}
        </View>
    );
}

const THUMB_SIZE = 68;

const styles = StyleSheet.create({
    wrapper: {
        gap: 14,
    },
    scrollContent: {
        gap: 10,
        paddingVertical: 4,
        paddingHorizontal: 2,
    },
    item: {
        alignItems: 'center',
        gap: 6,
    },
    thumbnail: {
        width: THUMB_SIZE,
        height: THUMB_SIZE,
        borderRadius: 14,
        overflow: 'hidden',
        borderWidth: 2,
        borderColor: '#1a1a1a',
    },
    thumbnailActive: {
        borderColor: '#6366f1',
        borderWidth: 2.5,
    },
    thumbImage: {
        width: THUMB_SIZE - 4,
        height: THUMB_SIZE - 4,
    },
    activeBadge: {
        position: 'absolute',
        bottom: 4,
        right: 4,
        width: 12,
        height: 12,
        borderRadius: 6,
        backgroundColor: 'rgba(0,0,0,0.6)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    activeDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: '#818cf8',
    },
    label: {
        fontSize: 10,
        fontWeight: '500',
        color: '#525252',
    },
    labelActive: {
        color: '#c7d2fe',
        fontWeight: '700',
    },
    intensityRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 4,
        gap: 10,
    },
    intensityLabel: {
        fontSize: 11,
        color: '#737373',
        fontWeight: '600',
    },
    intensitySlider: {
        flex: 1,
        height: 28,
    },
    intensityValue: {
        fontSize: 11,
        color: '#818cf8',
        fontWeight: '700',
        fontVariant: ['tabular-nums'],
        minWidth: 32,
        textAlign: 'right',
    },
});
