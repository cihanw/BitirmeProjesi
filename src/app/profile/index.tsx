import PageProvider from "@/src/components/page-provider";
import { ActivityIndicator, Alert, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { Divider, Surface } from "heroui-native";
import { Bolt, Info, ListCheck, LogOut, Star, Trash, UserRoundPen } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useState } from "react";
import { trackEvent } from "@/src/mixpanel";
import { clearSupabaseAuthStorage, supabase } from "@/lib/supabase";
import { useAuthContext } from "@/src/hooks/auth-hooks";
import { goBackOrReplace } from "@/src/lib/navigation";
import { deleteCurrentAccount } from "@/src/lib/api/auth";
import { clearSyncMap } from "@/src/lib/local-sync-store";
import { clearRecentSearchQueries } from "@/src/lib/search-history";
import { clearSavedLibraryAssets } from "@/src/lib/saved-assets-store";
import { cancelLaunchSearchSync } from "@/src/lib/sync-service";

export default function Profile() {
    const { profile } = useAuthContext();
    const { t } = useTranslation();
    const router = useRouter();
    const [isDeletingAccount, setIsDeletingAccount] = useState(false);

    const handleBack = () => {
        trackEvent("go_back_from_profile");
        goBackOrReplace(router, "/home");
    };

    const navigateToUpgrade = () => {
        trackEvent("go_to_upgrade_from_profile");
        router.push("/paywalls/first_paywall");
    };

    const confirmDeleteAccount = async () => {
        if (isDeletingAccount) return;

        trackEvent("confirm_delete_account_from_profile");
        setIsDeletingAccount(true);

        try {
            cancelLaunchSearchSync();
            await deleteCurrentAccount();
            await Promise.allSettled([
                clearSyncMap(),
                clearRecentSearchQueries(),
                clearSavedLibraryAssets(),
            ]);
            const { error: signOutError } = await supabase.auth.signOut({ scope: "local" });
            if (signOutError) {
                console.warn("Local sign out after account deletion failed:", signOutError);
                await clearSupabaseAuthStorage();
            }
            router.replace("/");
        } catch (error) {
            console.error("Error deleting account:", error);
            const message = error instanceof Error
                ? error.message
                : "Your account could not be deleted. Please try again.";
            Alert.alert("Hesap Silinemedi", message);
        } finally {
            setIsDeletingAccount(false);
        }
    };

    const deleteAccount = () => {
        trackEvent("go_to_delete_account_from_profile");
        Alert.alert(
            "Hesabı Sil?",
            "Bu işlem geri alınamaz. Emin misin?",
            [
                {
                    text: "Vazgeç",
                    style: "cancel",
                },
                {
                    text: "Sil",
                    style: "destructive",
                    onPress: () => {
                        void confirmDeleteAccount();
                    },
                },
            ],
        );
    };

    const logout = async () => {
        trackEvent("go_to_logout_from_profile");
        cancelLaunchSearchSync();
        const { error } = await supabase.auth.signOut();
        if (error) {
            console.error("Error logging out:", error);
            return;
        }
        await clearSyncMap();
        router.replace("/");
    };


    return (
        <PageProvider>
            <ScrollView showsVerticalScrollIndicator={false}>
                <View>
                    <TouchableOpacity onPress={handleBack} hitSlop={10}>
                        <Ionicons name="chevron-back" size={24} color="#737272" />
                    </TouchableOpacity>
                </View>

                <View className="mt-4">
                    <Text className="text-3xl font-medium mt-4">{t('profile.title')}</Text>
                    <View className="mt-8">
                        <Text className="text-2xl font-medium">{profile?.username}</Text>
                        <Text className="text-md text-muted-foreground">{t('profile.status_free')}</Text>
                    </View>
                </View>

                <Divider className="my-6" />

                <Surface className="p-4 gap-6">
                    <TouchableOpacity className="flex-row items-center gap-4" activeOpacity={0.7}>
                        <UserRoundPen size={24} color="#737272" />
                        <Text className="text-lg text-muted-foreground">{t('profile.menu.edit_profile')}</Text>
                    </TouchableOpacity>

                    <TouchableOpacity className="flex-row items-center gap-4" activeOpacity={0.7}>
                        <ListCheck size={24} color="#737272" />
                        <Text className="text-lg text-muted-foreground">{t('profile.menu.permissions')}</Text>
                    </TouchableOpacity>

                    <TouchableOpacity className="flex-row items-center gap-4" activeOpacity={0.7}>
                        <Star size={24} color="#737272" />
                        <Text className="text-lg text-muted-foreground">{t('profile.menu.rate_app')}</Text>
                    </TouchableOpacity>
                </Surface>

                <Divider className="my-6" />

                <Text className="text-2xl font-medium">{t('profile.sections.premium')}</Text>
                <Surface className="p-4 gap-6 mt-4">
                    <TouchableOpacity
                        className="flex-row items-center gap-4"
                        onPress={navigateToUpgrade}
                        activeOpacity={0.7}
                    >
                        <Bolt size={24} color="#737272" />
                        <Text className="text-lg text-muted-foreground">{t('profile.menu.upgrade')}</Text>
                    </TouchableOpacity>
                </Surface>

                <Divider className="my-6" />

                <Text className="text-2xl font-medium">{t('profile.sections.support')}</Text>
                <Surface className="p-4 gap-6 mt-4 mb-10">
                    <TouchableOpacity className="flex-row items-center gap-4" activeOpacity={0.7}>
                        <Info size={24} color="#737272" />
                        <Text className="text-lg text-muted-foreground">{t('profile.menu.contact')}</Text>
                    </TouchableOpacity>
                </Surface>

                <Divider className="my-6" />

                <Text className="text-2xl font-medium text-red-400">{t('profile.dangerZone.title')}</Text>
                <Surface className="p-4 gap-6 mt-4 mb-10">
                    <TouchableOpacity
                        onPress={deleteAccount}
                        disabled={isDeletingAccount}
                        className="flex-row items-center gap-4" activeOpacity={0.7}>
                        <Trash size={24} color="#737272" />
                        <Text className="text-lg text-muted-foreground">
                            {isDeletingAccount ? 'Hesap Siliniyor...' : t('profile.dangerZone.deleteAccount')}
                        </Text>
                        {isDeletingAccount ? <ActivityIndicator size="small" color="#737272" /> : null}
                    </TouchableOpacity>
                    <TouchableOpacity
                        onPress={logout}
                        className="flex-row items-center gap-4" activeOpacity={0.7}>
                        <LogOut size={24} color="#737272" />
                        <Text className="text-lg text-muted-foreground">{t('profile.dangerZone.logout')}</Text>
                    </TouchableOpacity>
                </Surface>
            </ScrollView>
        </PageProvider>
    );
}
