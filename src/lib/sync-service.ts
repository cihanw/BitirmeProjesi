import { uploadSearchablePhoto } from '@/src/lib/api/upload';
import {
    type PickedAsset,
    getLastSeenPhotoCreationTime,
    getUnsyncedAssetIds,
    hasAnySyncedAssets,
    hasCompletedLaunchSync,
    markLaunchSyncCompleted,
    updateLastSeenPhotoCreationTime,
} from '@/src/lib/local-sync-store';
import { checkMediaPermission, fetchRecentPhotos, getAssetById, type Asset } from '@/src/lib/media-library';

const INITIAL_SCAN_LIMIT = 30;
const INITIAL_SYNC_BATCH_LIMIT = 5;
const NEW_PHOTO_SCAN_LIMIT = 30;

export type SyncLaunchSummary = {
    status:
    | 'completed'
    | 'cancelled'
    | 'skipped_no_permission'
    | 'skipped_backend_not_configured'
    | 'skipped_no_work';
    scanned: number;
    queued: number;
    failed: number;
};

let inFlightSync: Promise<SyncLaunchSummary> | null = null;
let inFlightSyncKey: string | null = null;
let activeSyncRunId = 0;

function hasBackendUrl(): boolean {
    return Boolean(process.env.EXPO_PUBLIC_BACKEND_URL?.trim());
}

function buildCancelledSummary(scanned: number, queued: number, failed: number): SyncLaunchSummary {
    return {
        status: 'cancelled',
        scanned,
        queued,
        failed,
    };
}

function isRunCancelled(runId: number): boolean {
    return runId !== activeSyncRunId;
}

function getMaxCreationTime(assets: Array<Asset | PickedAsset>): number {
    return assets.reduce((maxCreationTime, asset) => {
        const creationTime = asset.creationTime;
        if (typeof creationTime !== 'number' || !Number.isFinite(creationTime)) {
            return maxCreationTime;
        }

        return Math.max(maxCreationTime, creationTime);
    }, 0);
}

function isPhotoAsset(asset: Asset): boolean {
    return String(asset.mediaType).toLowerCase() === 'photo';
}

async function uploadAssetIds(
    assetIds: string[],
    scanned: number,
    runId?: number,
): Promise<SyncLaunchSummary> {
    let queued = 0;
    let failed = 0;

    for (const assetId of assetIds) {
        if (runId !== undefined && isRunCancelled(runId)) {
            return buildCancelledSummary(scanned, queued, failed);
        }

        try {
            const assetInfo = await getAssetById(assetId);
            if (runId !== undefined && isRunCancelled(runId)) {
                return buildCancelledSummary(scanned, queued, failed);
            }

            await uploadSearchablePhoto({
                assetId,
                asset: assetInfo,
            });
            queued += 1;
        } catch (error) {
            if (error instanceof Error && error.message === 'backend_not_configured') {
                return {
                    status: 'skipped_backend_not_configured',
                    scanned,
                    queued,
                    failed,
                };
            }

            failed += 1;
        }
    }

    return {
        status: assetIds.length === 0 ? 'skipped_no_work' : 'completed',
        scanned,
        queued,
        failed,
    };
}

async function runLaunchSync(runId: number, syncKey: string): Promise<SyncLaunchSummary> {
    if (!hasBackendUrl()) {
        return {
            status: 'skipped_backend_not_configured',
            scanned: 0,
            queued: 0,
            failed: 0,
        };
    }

    const hasCompletedBootstrap = await hasCompletedLaunchSync(syncKey);
    if (hasCompletedBootstrap) {
        return {
            status: 'skipped_no_work',
            scanned: 0,
            queued: 0,
            failed: 0,
        };
    }

    if (await hasAnySyncedAssets()) {
        const latestAsset = await fetchRecentPhotos(1);
        await updateLastSeenPhotoCreationTime(syncKey, getMaxCreationTime(latestAsset));
        await markLaunchSyncCompleted(syncKey);
        return {
            status: 'skipped_no_work',
            scanned: latestAsset.length,
            queued: 0,
            failed: 0,
        };
    }

    const hasPermission = await checkMediaPermission();
    if (!hasPermission) {
        return {
            status: 'skipped_no_permission',
            scanned: 0,
            queued: 0,
            failed: 0,
        };
    }

    const recentAssets = await fetchRecentPhotos(INITIAL_SCAN_LIMIT);
    if (isRunCancelled(runId)) {
        return buildCancelledSummary(recentAssets.length, 0, 0);
    }

    const unsyncedAssetIds = await getUnsyncedAssetIds(recentAssets.map((asset) => asset.id));
    const nextBatch = unsyncedAssetIds.slice(0, INITIAL_SYNC_BATCH_LIMIT);

    if (nextBatch.length === 0) {
        await updateLastSeenPhotoCreationTime(syncKey, getMaxCreationTime(recentAssets));
        return {
            status: 'skipped_no_work',
            scanned: recentAssets.length,
            queued: 0,
            failed: 0,
        };
    }

    const summary = await uploadAssetIds(nextBatch, recentAssets.length, runId);
    if (summary.status === 'completed' && summary.failed === 0) {
        await updateLastSeenPhotoCreationTime(syncKey, getMaxCreationTime(recentAssets));
    }

    return summary;
}

export function cancelLaunchSearchSync(): void {
    activeSyncRunId += 1;
    inFlightSync = null;
    inFlightSyncKey = null;
}

export function ensureLaunchSearchSync(syncKey = 'default'): Promise<SyncLaunchSummary> {
    if (inFlightSync && inFlightSyncKey === syncKey) {
        return inFlightSync;
    }

    const runId = activeSyncRunId;
    inFlightSyncKey = syncKey;
    inFlightSync = runLaunchSync(runId, syncKey).then(async (summary) => {
        if (summary.status === 'completed' || summary.status === 'skipped_no_work') {
            await markLaunchSyncCompleted(syncKey);
        }

        return summary;
    }).finally(() => {
        if (inFlightSyncKey === syncKey) {
            inFlightSync = null;
            inFlightSyncKey = null;
        }
    });

    return inFlightSync;
}

export async function syncNewLibraryPhotos(syncKey = 'default', insertedAssets?: Asset[]): Promise<SyncLaunchSummary> {
    if (!hasBackendUrl()) {
        return {
            status: 'skipped_backend_not_configured',
            scanned: 0,
            queued: 0,
            failed: 0,
        };
    }

    if (!await hasCompletedLaunchSync(syncKey)) {
        return {
            status: 'skipped_no_work',
            scanned: 0,
            queued: 0,
            failed: 0,
        };
    }

    const hasPermission = await checkMediaPermission();
    if (!hasPermission) {
        return {
            status: 'skipped_no_permission',
            scanned: 0,
            queued: 0,
            failed: 0,
        };
    }

    const candidateAssets = insertedAssets && insertedAssets.length > 0
        ? insertedAssets
        : await fetchRecentPhotos(NEW_PHOTO_SCAN_LIMIT);
    const photoAssets = candidateAssets.filter(isPhotoAsset);
    const lastSeenCreationTime = await getLastSeenPhotoCreationTime(syncKey);
    const newAssets = photoAssets.filter((asset) => {
        const creationTime = asset.creationTime;
        return typeof creationTime === 'number' &&
            Number.isFinite(creationTime) &&
            creationTime > lastSeenCreationTime;
    });

    if (newAssets.length === 0) {
        await updateLastSeenPhotoCreationTime(syncKey, getMaxCreationTime(photoAssets));
        return {
            status: 'skipped_no_work',
            scanned: photoAssets.length,
            queued: 0,
            failed: 0,
        };
    }

    const unsyncedAssetIds = await getUnsyncedAssetIds(newAssets.map((asset) => asset.id));
    const summary = await uploadAssetIds(unsyncedAssetIds, photoAssets.length);
    if (summary.failed === 0) {
        await updateLastSeenPhotoCreationTime(syncKey, getMaxCreationTime(photoAssets));
    }

    return summary;
}
