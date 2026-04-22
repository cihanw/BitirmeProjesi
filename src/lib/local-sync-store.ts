import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'local_sync_map_v1';
const PICKED_KEY = 'picked_asset_map_v1';
const LAUNCH_SYNC_KEY = 'launch_sync_completed_v1';
const LAST_SEEN_PHOTO_KEY = 'launch_sync_last_seen_photo_v1';

type SyncMap = Record<string, string>;
type PickedAssetMap = Record<string, PickedAsset>;
type LaunchSyncMap = Record<string, true>;
type LastSeenPhotoMap = Record<string, number>;

export type PickedAsset = {
    uri: string;
    assetId?: string | null;
    filename?: string | null;
    width?: number | null;
    height?: number | null;
    creationTime?: number;
};

export type PickedAssetEntry = {
    id: string;
    asset: PickedAsset;
};

async function readMap(): Promise<SyncMap> {
    try {
        const raw = await AsyncStorage.getItem(KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

async function writeMap(map: SyncMap): Promise<void> {
    await AsyncStorage.setItem(KEY, JSON.stringify(map));
}

async function readPickedMap(): Promise<PickedAssetMap> {
    try {
        const raw = await AsyncStorage.getItem(PICKED_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

async function writePickedMap(map: PickedAssetMap): Promise<void> {
    await AsyncStorage.setItem(PICKED_KEY, JSON.stringify(map));
}

async function readLaunchSyncMap(): Promise<LaunchSyncMap> {
    try {
        const raw = await AsyncStorage.getItem(LAUNCH_SYNC_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

async function writeLaunchSyncMap(map: LaunchSyncMap): Promise<void> {
    await AsyncStorage.setItem(LAUNCH_SYNC_KEY, JSON.stringify(map));
}

async function readLastSeenPhotoMap(): Promise<LastSeenPhotoMap> {
    try {
        const raw = await AsyncStorage.getItem(LAST_SEEN_PHOTO_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

async function writeLastSeenPhotoMap(map: LastSeenPhotoMap): Promise<void> {
    await AsyncStorage.setItem(LAST_SEEN_PHOTO_KEY, JSON.stringify(map));
}

export async function saveMapping(localAssetId: string, backendUUID: string): Promise<void> {
    const map = await readMap();
    map[localAssetId] = backendUUID;
    await writeMap(map);
}

export async function getBackendUUID(localAssetId: string): Promise<string | null> {
    const map = await readMap();
    return map[localAssetId] ?? null;
}

export async function getLocalAssetId(backendUUID: string): Promise<string | null> {
    const map = await readMap();
    const entry = Object.entries(map).find(([, uuid]) => uuid === backendUUID);
    return entry ? entry[0] : null;
}

export async function removeMapping(localAssetId: string): Promise<void> {
    const map = await readMap();
    if (!(localAssetId in map)) return;

    delete map[localAssetId];
    await writeMap(map);
}

export async function savePickedAsset(localAssetId: string, asset: PickedAsset): Promise<void> {
    const map = await readPickedMap();
    map[localAssetId] = asset;
    await writePickedMap(map);
}

export async function getPickedAsset(localAssetId: string): Promise<PickedAsset | null> {
    const map = await readPickedMap();
    return map[localAssetId] ?? null;
}

export async function removePickedAsset(localAssetId: string): Promise<void> {
    const map = await readPickedMap();
    if (!(localAssetId in map)) return;

    delete map[localAssetId];
    await writePickedMap(map);
    await removeMapping(localAssetId);
}

export async function listPickedAssets(): Promise<PickedAssetEntry[]> {
    const map = await readPickedMap();

    return Object.entries(map)
        .map(([id, asset]) => ({ id, asset }))
        .sort((left, right) => (right.asset.creationTime ?? 0) - (left.asset.creationTime ?? 0));
}

export async function getUnsyncedAssetIds(allLocalIds: string[]): Promise<string[]> {
    const map = await readMap();
    return allLocalIds.filter((id) => !map[id]);
}

export async function hasAnySyncedAssets(): Promise<boolean> {
    const map = await readMap();
    return Object.keys(map).length > 0;
}

export async function hasCompletedLaunchSync(syncKey: string): Promise<boolean> {
    const map = await readLaunchSyncMap();
    return Boolean(map[syncKey]);
}

export async function markLaunchSyncCompleted(syncKey: string): Promise<void> {
    const map = await readLaunchSyncMap();
    map[syncKey] = true;
    await writeLaunchSyncMap(map);
}

export async function getLastSeenPhotoCreationTime(syncKey: string): Promise<number> {
    const map = await readLastSeenPhotoMap();
    const value = map[syncKey];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export async function updateLastSeenPhotoCreationTime(syncKey: string, creationTime?: number | null): Promise<void> {
    if (typeof creationTime !== 'number' || !Number.isFinite(creationTime) || creationTime <= 0) {
        return;
    }

    const map = await readLastSeenPhotoMap();
    const current = map[syncKey] ?? 0;
    map[syncKey] = Math.max(current, creationTime);
    await writeLastSeenPhotoMap(map);
}

export async function clearSyncMap(): Promise<void> {
    await AsyncStorage.removeItem(KEY);
    await AsyncStorage.removeItem(PICKED_KEY);
    await AsyncStorage.removeItem(LAUNCH_SYNC_KEY);
    await AsyncStorage.removeItem(LAST_SEEN_PHOTO_KEY);
}
