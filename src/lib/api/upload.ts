import { supabase } from '@/lib/supabase';
import * as FileSystem from 'expo-file-system/legacy';
import { getBackendUUID, getPickedAsset, saveMapping, savePickedAsset } from '@/src/lib/local-sync-store';
import type { AssetInfo } from '@/src/lib/media-library';

type UploadSearchablePhotoParams = {
    assetId: string;
    asset: AssetInfo;
};

type UploadFileForSearchParams = {
    sourceId: string;
    fileUri: string;
    filename?: string | null;
    creationTime?: number;
};

type FetchUploadWithRetryParams = UploadFileForSearchParams & {
    baseUrl: string;
    accessToken?: string;
};

type UploadSearchablePhotoResponse = {
    imageUuid: string;
    photoId: string;
};

export const DUPLICATE_SMART_GALLERY_PHOTO = 'duplicate_smart_gallery_photo';
const NETWORK_UPLOAD_MAX_ATTEMPTS = 3;
const NETWORK_UPLOAD_RETRY_DELAYS_MS = [400, 900];

function stableHash(value: string): string {
    let hash = 5381;

    for (let index = 0; index < value.length; index += 1) {
        hash = ((hash << 5) + hash) + value.charCodeAt(index);
        hash >>>= 0;
    }

    return hash.toString(16);
}

async function buildPickedSourceId(params: { uri: string; assetId?: string | null }): Promise<string> {
    const deviceAssetId = params.assetId?.trim();
    if (deviceAssetId) {
        return `picked:${deviceAssetId}`;
    }

    try {
        const info = await FileSystem.getInfoAsync(params.uri, { md5: true });
        if (info.exists && info.md5) {
            return `picked:file-${info.md5}`;
        }
    } catch {
        // Fall back to the URI hash when the picker file cannot be read.
    }

    return `picked:uri-${stableHash(params.uri)}`;
}

function resolveBackendBaseUrl(): string | null {
    const envUrl = process.env.EXPO_PUBLIC_BACKEND_URL?.trim();
    return envUrl ? envUrl.replace(/\/$/, '') : null;
}

function inferMimeType(filename?: string | null): string {
    const lowered = filename?.toLowerCase() ?? '';

    if (lowered.endsWith('.png')) return 'image/png';
    if (lowered.endsWith('.webp')) return 'image/webp';
    if (lowered.endsWith('.heic') || lowered.endsWith('.heif')) return 'image/heic';

    return 'image/jpeg';
}

function isNetworkRequestFailed(error: unknown): boolean {
    if (!(error instanceof Error)) return false;

    return error.message.trim().toLowerCase() === 'network request failed';
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildUploadFormData({
    sourceId,
    fileUri,
    filename,
    creationTime,
}: UploadFileForSearchParams): FormData {
    const formData = new FormData();
    formData.append('photo_id', sourceId);

    if (creationTime) {
        formData.append('captured_at', new Date(creationTime).toISOString());
    }

    formData.append('file', {
        uri: fileUri,
        name: filename ?? `${sourceId}.jpg`,
        type: inferMimeType(filename),
    } as any);

    return formData;
}

async function fetchUploadWithNetworkRetry(params: FetchUploadWithRetryParams): Promise<Response> {
    for (let attempt = 1; attempt <= NETWORK_UPLOAD_MAX_ATTEMPTS; attempt += 1) {
        try {
            return await fetch(`${params.baseUrl}/api/upload`, {
                method: 'POST',
                headers: {
                    ...(params.accessToken
                        ? { Authorization: `Bearer ${params.accessToken}` }
                        : {}),
                },
                body: buildUploadFormData(params),
            });
        } catch (error) {
            const shouldRetry =
                isNetworkRequestFailed(error) &&
                attempt < NETWORK_UPLOAD_MAX_ATTEMPTS;

            if (!shouldRetry) {
                throw error;
            }

            await wait(NETWORK_UPLOAD_RETRY_DELAYS_MS[attempt - 1] ?? 900);
        }
    }

    throw new Error('Network request failed');
}

export async function uploadSearchablePhoto({
    assetId,
    asset,
}: UploadSearchablePhotoParams): Promise<UploadSearchablePhotoResponse> {
    return uploadFileForSearch({
        sourceId: assetId,
        fileUri: asset.localUri ?? asset.uri ?? '',
        filename: asset.filename,
        creationTime: asset.creationTime,
    });
}

export async function uploadFileForSearch({
    sourceId,
    fileUri,
    filename,
    creationTime,
}: UploadFileForSearchParams): Promise<UploadSearchablePhotoResponse> {
    const baseUrl = resolveBackendBaseUrl();
    if (!baseUrl) {
        throw new Error('backend_not_configured');
    }

    if (!fileUri) {
        throw new Error('missing_asset_uri');
    }

    let accessToken: string | undefined;
    try {
        const {
            data: { session },
        } = await supabase.auth.getSession();
        accessToken = session?.access_token;
    } catch {
        accessToken = undefined;
    }

    const response = await fetchUploadWithNetworkRetry({
        baseUrl,
        accessToken,
        sourceId,
        fileUri,
        filename,
        creationTime,
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const detail =
            typeof payload?.detail === 'string'
                ? payload.detail
                : `upload_failed_${response.status}`;
        throw new Error(detail);
    }

    const imageUuid = payload?.image_uuid;
    const photoId = payload?.photo_id;

    if (!imageUuid || !photoId) {
        throw new Error('invalid_upload_response');
    }

    await saveMapping(sourceId, imageUuid);

    return {
        imageUuid,
        photoId,
    };
}

export async function uploadPickedPhotoForSearch(params: {
    uri: string;
    assetId?: string | null;
    filename?: string | null;
    width?: number | null;
    height?: number | null;
    creationTime?: number;
}): Promise<UploadSearchablePhotoResponse> {
    const sourceId = await buildPickedSourceId(params);
    const [existingPickedAsset, existingBackendUUID] = await Promise.all([
        getPickedAsset(sourceId),
        getBackendUUID(sourceId),
    ]);

    if (existingPickedAsset || existingBackendUUID) {
        throw new Error(DUPLICATE_SMART_GALLERY_PHOTO);
    }

    const result = await uploadFileForSearch({
        sourceId,
        fileUri: params.uri,
        filename: params.filename,
        creationTime: params.creationTime,
    });

    await savePickedAsset(sourceId, {
        uri: params.uri,
        assetId: params.assetId,
        filename: params.filename,
        width: params.width,
        height: params.height,
        creationTime: params.creationTime,
    });

    return result;
}
