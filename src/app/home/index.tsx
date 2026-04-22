import { useCallback, useEffect, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';
import {
    ActivityIndicator,
    Keyboard,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LayoutGrid, Search, UserRound, Users, X } from 'lucide-react-native';

import { GalleryGrid } from '@/src/components/gallery/GalleryGrid';
import { PhotoResultsGrid, type SearchResultPhoto } from '@/src/components/gallery/PhotoResultsGrid';
import { clearRemoteSearchCache, searchPhotos } from '@/src/lib/api/search';
import { clearSyncMap } from '@/src/lib/local-sync-store';
import {
    clearRecentSearchQueries,
    listRecentSearchQueries,
    saveRecentSearchQuery,
} from '@/src/lib/search-history';

export default function HomePage() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const [query, setQuery] = useState('');
    const [submittedQuery, setSubmittedQuery] = useState('');
    const [results, setResults] = useState<SearchResultPhoto[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [isClearingLocalCache, setIsClearingLocalCache] = useState(false);
    const [searchHint, setSearchHint] = useState<string | null>(null);
    const [recentSearches, setRecentSearches] = useState<string[]>([]);
    const [isOffline, setIsOffline] = useState(false);
    const isSearchMode = submittedQuery.length > 0;

    useEffect(() => {
        const unsubscribe = NetInfo.addEventListener((state) => {
            setIsOffline(!(state.isConnected && state.isInternetReachable !== false));
        });
        return unsubscribe;
    }, []);

    useEffect(() => {
        listRecentSearchQueries()
            .then(setRecentSearches)
            .catch(() => setRecentSearches([]));
    }, []);

    const runSearch = useCallback(async (rawQuery: string) => {
        const trimmedQuery = rawQuery.trim();
        if (!trimmedQuery) {
            setSubmittedQuery('');
            setResults([]);
            setSearchHint(null);
            return;
        }

        Keyboard.dismiss();
        setQuery(trimmedQuery);
        setSubmittedQuery(trimmedQuery);
        setIsSearching(true);

        try {
            const response = await searchPhotos(trimmedQuery);
            setResults(response.photos);
            const nextRecentSearches = await saveRecentSearchQuery(trimmedQuery);
            setRecentSearches(nextRecentSearches);

            if (!response.usedFallback) {
                setSearchHint(null);
            } else if (response.fallbackReason === 'backend_degraded') {
                setSearchHint('Backend ayakta, ama Supabase tarafindan senkron sonuc donmedi. Yerel index eslesmeleri gosteriliyor.');
            } else if (response.fallbackReason === 'backend_unavailable') {
                setSearchHint('Backend simdilik ulasilamiyor. Yerel eslesmeler gosteriliyor.');
            } else if (response.fallbackReason === 'backend_not_configured') {
                setSearchHint('Backend URL ayarlanmadigi icin yerel eslesmeler gosteriliyor.');
            } else {
                setSearchHint('Senkronlu sonuc bulunamadi. Yerel tahmini eslesmeler gosteriliyor.');
            }
        } finally {
            setIsSearching(false);
        }
    }, []);

    const handleSearch = useCallback(async () => {
        await runSearch(query);
    }, [query, runSearch]);

    const clearSearch = useCallback(() => {
        setQuery('');
        setSubmittedQuery('');
        setResults([]);
        setSearchHint(null);
    }, []);

    const handleSuggestionPress = useCallback(async (suggestion: string) => {
        await runSearch(suggestion);
    }, [runSearch]);

    const handleClearRecentSearches = useCallback(async () => {
        await clearRecentSearchQueries();
        setRecentSearches([]);
    }, []);

    const clearLocalCache = async () => {
        setIsClearingLocalCache(true);
        try {
            const remoteCleanup = await clearRemoteSearchCache();
            await clearSyncMap();
            setResults([]);
            setSubmittedQuery('');

            if (remoteCleanup.remoteCleared) {
                setSearchHint('Yerel cache ve Supabase tarafindaki kullanici index verileri temizlendi.');
            } else if (remoteCleanup.reason === 'backend_not_configured') {
                setSearchHint('Yerel cache temizlendi. Backend URL ayarsiz oldugu icin Supabase temizligi atlandi.');
            } else {
                setSearchHint('Yerel cache temizlendi. Supabase temizligi su an yapilamadi.');
            }
        } finally {
            setIsClearingLocalCache(false);
        }
    };

    return (
        <View style={[styles.root, { paddingTop: insets.top }]}>
            <View style={styles.header}>
                <Text style={styles.title}>Photos</Text>
                <View style={styles.actions}>
                    <TouchableOpacity onPress={() => router.push('/people' as any)} style={styles.iconBtn}>
                        <Users size={22} color="#737272" />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => router.push('/albums' as any)} style={styles.iconBtn}>
                        <LayoutGrid size={22} color="#737272" />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => router.replace('/profile')} style={styles.iconBtn}>
                        <UserRound size={22} color="#737272" />
                    </TouchableOpacity>
                </View>
            </View>

            {isOffline && (
                <View style={styles.offlineStrip}>
                    <Text style={styles.offlineText}>📵 Offline moddasınız</Text>
                </View>
            )}

            <View style={styles.searchShell}>
                <View style={styles.searchBar}>
                    <Search size={18} color="#737272" />
                    <TextInput
                        value={query}
                        onChangeText={setQuery}
                        onSubmitEditing={handleSearch}
                        placeholder="Search for sunsets, birthdays, trips..."
                        placeholderTextColor="#9ca3af"
                        returnKeyType="search"
                        style={styles.searchInput}
                    />
                    {query.length > 0 ? (
                        <TouchableOpacity onPress={clearSearch} style={styles.clearBtn}>
                            <X size={16} color="#737272" />
                        </TouchableOpacity>
                    ) : null}
                </View>
                <TouchableOpacity
                    style={[styles.searchAction, query.trim().length === 0 && styles.searchActionDisabled]}
                    onPress={handleSearch}
                    disabled={query.trim().length === 0}
                >
                    <Text style={styles.searchActionText}>Go</Text>
                </TouchableOpacity>
            </View>

            {!isSearchMode ? (
                <View>
                    {recentSearches.length > 0 ? (
                        <View style={styles.recentSection}>
                            <View style={styles.sectionHeader}>
                                <Text style={styles.sectionTitle}>Recent Searches</Text>
                                <TouchableOpacity onPress={handleClearRecentSearches}>
                                    <Text style={styles.sectionAction}>Clear</Text>
                                </TouchableOpacity>
                            </View>
                            <ScrollView
                                horizontal
                                showsHorizontalScrollIndicator={false}
                                contentContainerStyle={styles.suggestionRow}
                            >
                                {recentSearches.map((suggestion) => (
                                    <TouchableOpacity
                                        key={suggestion}
                                        style={[styles.suggestionChip, styles.recentChip]}
                                        onPress={() => handleSuggestionPress(suggestion)}
                                    >
                                        <Text style={styles.suggestionText}>{suggestion}</Text>
                                    </TouchableOpacity>
                                ))}
                            </ScrollView>
                        </View>
                    ) : null}
                </View>
            ) : (
                <View style={styles.resultsBar}>
                    <Text style={styles.resultsText}>
                        {isSearching ? 'Searching...' : `${results.length} ${results.length === 1 ? 'match' : 'matches'} for "${submittedQuery}"`}
                    </Text>
                    <TouchableOpacity onPress={clearSearch}>
                        <Text style={styles.resultsAction}>Clear</Text>
                    </TouchableOpacity>
                </View>
            )}

            {searchHint ? (
                <View style={styles.banner}>
                    <Text style={styles.bannerText}>{searchHint}</Text>
                    <TouchableOpacity onPress={clearLocalCache} disabled={isClearingLocalCache}>
                        <Text style={styles.bannerActionText}>
                            {isClearingLocalCache ? 'Temizleniyor...' : 'Yerel cache temizle'}
                        </Text>
                    </TouchableOpacity>
                </View>
            ) : null}

            <View style={styles.gallery}>
                {isSearching ? (
                    <View style={styles.center}>
                        <ActivityIndicator size="large" />
                        <Text style={styles.stateText}>Searching your gallery...</Text>
                    </View>
                ) : isSearchMode ? (
                    results.length > 0 ? (
                        <PhotoResultsGrid
                            photos={results}
                            onPress={(photo) => router.push(`/photo-detail/${photo.id}` as any)}
                        />
                    ) : (
                        <View style={styles.center}>
                            <Text style={styles.emptyTitle}>No results for &quot;{submittedQuery}&quot;</Text>
                            <Text style={styles.stateText}>
                                Try broader words like month names, filenames, or simpler topics.
                            </Text>
                        </View>
                    )
                ) : (
                    <GalleryGrid />
                )}
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: '#fff' },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    title: { fontSize: 26, fontWeight: '700', letterSpacing: -0.5 },
    actions: { flexDirection: 'row', gap: 8 },
    iconBtn: { padding: 8, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.05)' },
    searchShell: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 16,
        paddingBottom: 12,
    },
    searchBar: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: 18,
        borderWidth: 1,
        borderColor: '#e5e7eb',
        backgroundColor: '#f8fafc',
        paddingHorizontal: 12,
        minHeight: 48,
    },
    searchInput: {
        flex: 1,
        fontSize: 15,
        color: '#111827',
        paddingVertical: 12,
        paddingHorizontal: 10,
    },
    clearBtn: {
        width: 28,
        height: 28,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#e5e7eb',
    },
    searchAction: {
        minHeight: 48,
        borderRadius: 16,
        backgroundColor: '#111827',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 16,
    },
    searchActionDisabled: {
        opacity: 0.45,
    },
    searchActionText: {
        color: '#fff',
        fontSize: 14,
        fontWeight: '700',
    },
    suggestionRow: {
        gap: 8,
        paddingHorizontal: 16,
        paddingBottom: 12,
    },
    recentSection: {
        paddingTop: 2,
    },
    sectionHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingBottom: 8,
    },
    sectionTitle: {
        fontSize: 13,
        fontWeight: '700',
        color: '#374151',
        letterSpacing: 0.2,
    },
    sectionAction: {
        fontSize: 13,
        fontWeight: '700',
        color: '#4f46e5',
    },
    suggestionChip: {
        borderRadius: 999,
        backgroundColor: '#eef2ff',
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    recentChip: {
        backgroundColor: '#ede9fe',
    },
    suggestionText: {
        color: '#4338ca',
        fontSize: 13,
        fontWeight: '700',
    },
    resultsBar: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingBottom: 12,
        gap: 12,
    },
    resultsText: {
        flex: 1,
        color: '#4b5563',
        fontSize: 13,
    },
    resultsAction: {
        color: '#4f46e5',
        fontSize: 13,
        fontWeight: '700',
    },
    banner: {
        marginHorizontal: 16,
        marginBottom: 12,
        borderRadius: 14,
        backgroundColor: '#eef2ff',
        paddingHorizontal: 14,
        paddingVertical: 10,
    },
    bannerText: {
        color: '#4338ca',
        fontSize: 12,
        lineHeight: 18,
    },
    bannerActionText: {
        marginTop: 8,
        color: '#3730a3',
        fontSize: 12,
        fontWeight: '700',
    },
    offlineStrip: {
        marginHorizontal: 16,
        marginBottom: 8,
        borderRadius: 10,
        backgroundColor: '#fef3c7',
        paddingHorizontal: 12,
        paddingVertical: 6,
        alignItems: 'center',
    },
    offlineText: {
        color: '#92400e',
        fontSize: 12,
        fontWeight: '600',
    },
    gallery: { flex: 1 },
    center: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 24,
        gap: 10,
    },
    emptyTitle: {
        fontSize: 18,
        fontWeight: '700',
        color: '#111827',
        textAlign: 'center',
    },
    stateText: {
        color: '#6b7280',
        fontSize: 14,
        lineHeight: 21,
        textAlign: 'center',
    },
});
