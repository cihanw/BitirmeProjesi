import Constants, { ExecutionEnvironment } from 'expo-constants';
import type { ReactNode } from 'react';
import React, { useEffect, useMemo, useRef } from 'react';
import { Image as RNImage, Platform, StyleSheet } from 'react-native';
import {
    Canvas,
    ColorMatrix as SkiaColorMatrix,
    Image as SkiaImage,
    useImage,
} from '@shopify/react-native-skia';
import colorMatrices from 'rn-color-matrices';

export type Matrix = number[];

type ColorMatrixProps = {
    matrix?: Matrix | null;
    children?: ReactNode;
};

const IDENTITY_MATRIX: Matrix = [
    1, 0, 0, 0, 0,
    0, 1, 0, 0, 0,
    0, 0, 1, 0, 0,
    0, 0, 0, 1, 0,
];

const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
// Native filters are not available in Expo Go, so this import must stay conditional.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nativeFilters = isExpoGo ? null : require('react-native-color-matrix-image-filters');

const matrixFrom = (name: string, fallback: Matrix) => (...args: unknown[]): Matrix => {
    const fn = (colorMatrices as Record<string, (...args: unknown[]) => Matrix>)[name] ?? nativeFilters?.[name];
    return typeof fn === 'function' ? [...fn(...args)] : [...fallback];
};

export function ColorMatrix({ children, matrix }: ColorMatrixProps) {
    const NativeColorMatrix = nativeFilters?.ColorMatrix;
    if (!matrix) return <>{children}</>;
    if (!NativeColorMatrix) {
        const fallbackProps = getFallbackImageProps(children);
        if (fallbackProps) {
            return <SkiaImageColorMatrix {...fallbackProps} matrix={matrix} />;
        }
        return <>{children}</>;
    }
    return <NativeColorMatrix matrix={matrix}>{children}</NativeColorMatrix>;
}

export const normal = matrixFrom('normal', IDENTITY_MATRIX);
export const grayscale = matrixFrom('grayscale', IDENTITY_MATRIX);
export const sepia = matrixFrom('sepia', IDENTITY_MATRIX);
export const saturate = matrixFrom('saturate', IDENTITY_MATRIX);
export const warm = matrixFrom('warm', IDENTITY_MATRIX);
export const cool = matrixFrom('cool', IDENTITY_MATRIX);
export const kodachrome = matrixFrom('kodachrome', IDENTITY_MATRIX);
export const vintage = matrixFrom('vintage', IDENTITY_MATRIX);
export const brightness = matrixFrom('brightness', IDENTITY_MATRIX);
export const contrast = matrixFrom('contrast', IDENTITY_MATRIX);
export const temperature = matrixFrom('temperature', IDENTITY_MATRIX);
export const tint = matrixFrom('tint', IDENTITY_MATRIX);

export const concatColorMatrices = (...matrices: Matrix[]): Matrix => {
    if (matrices.length === 0) return [...IDENTITY_MATRIX];
    return matrices.reduce((acc, matrix) => concatTwoColorMatrices(acc, matrix)).slice();
};

type RNImageProps = React.ComponentProps<typeof RNImage>;

type FallbackImageProps = {
    source: NonNullable<RNImageProps['source']>;
    style: RNImageProps['style'];
    resizeMode?: RNImageProps['resizeMode'];
    onLoad?: RNImageProps['onLoad'];
};

function getFallbackImageProps(children: ReactNode): FallbackImageProps | null {
    const childArray = React.Children.toArray(children);
    if (childArray.length !== 1 || !React.isValidElement(childArray[0])) return null;

    const props = childArray[0].props as RNImageProps;
    if (!props?.source || !props?.style) return null;

    const flattened = StyleSheet.flatten(props.style);
    if (typeof flattened?.width !== 'number' || typeof flattened?.height !== 'number') return null;

    return {
        source: props.source,
        style: props.style,
        resizeMode: props.resizeMode,
        onLoad: props.onLoad,
    };
}

function SkiaImageColorMatrix({ source, style, resizeMode, onLoad, matrix }: FallbackImageProps & { matrix: Matrix }) {
    const resolvedSource = RNImage.resolveAssetSource(source);
    const uri = resolvedSource?.uri;
    const image = useImage(uri);
    const didNotifyLoadRef = useRef(false);
    const flattened = StyleSheet.flatten(style);
    const width = typeof flattened?.width === 'number' ? flattened.width : 0;
    const height = typeof flattened?.height === 'number' ? flattened.height : 0;
    const fit = resizeMode === 'cover' ? 'cover' : resizeMode === 'stretch' ? 'fill' : 'contain';
    const skiaMatrix = useMemo(() => normalizeMatrixForSkia(matrix), [matrix]);

    useEffect(() => {
        didNotifyLoadRef.current = false;
    }, [uri]);

    useEffect(() => {
        if (image && !didNotifyLoadRef.current) {
            didNotifyLoadRef.current = true;
            onLoad?.({} as Parameters<NonNullable<RNImageProps['onLoad']>>[0]);
        }
    }, [image, onLoad]);

    if (!uri || !image || width <= 0 || height <= 0) {
        return <RNImage source={source} style={style} resizeMode={resizeMode} onLoad={onLoad} />;
    }

    return (
        <Canvas style={style}>
            <SkiaImage image={image} x={0} y={0} width={width} height={height} fit={fit}>
                <SkiaColorMatrix matrix={skiaMatrix} />
            </SkiaImage>
        </Canvas>
    );
}

function normalizeMatrixForSkia(matrix: Matrix): Matrix {
    const next = [...matrix];
    if (Platform.OS !== 'ios') {
        next[4] /= 255;
        next[9] /= 255;
        next[14] /= 255;
        next[19] /= 255;
    }
    return next;
}

function concatTwoColorMatrices(matB: Matrix, matA: Matrix): Matrix {
    const tmp = Array(20);
    let index = 0;
    for (let j = 0; j < 20; j += 5) {
        for (let i = 0; i < 4; i += 1) {
            tmp[index] =
                matA[j] * matB[i] +
                matA[j + 1] * matB[i + 5] +
                matA[j + 2] * matB[i + 10] +
                matA[j + 3] * matB[i + 15];
            index += 1;
        }
        tmp[index] =
            matA[j] * matB[4] +
            matA[j + 1] * matB[9] +
            matA[j + 2] * matB[14] +
            matA[j + 3] * matB[19] +
            matA[j + 4];
        index += 1;
    }
    return tmp;
}
