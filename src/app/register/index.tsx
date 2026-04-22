import React, { useState } from 'react';
import { Image as RNImage, View, ScrollView, Text, TouchableOpacity } from 'react-native';
import { TextField, Button, FormField, Checkbox } from 'heroui-native';
import { supabase } from '@/lib/supabase';
import { useRouter, Link } from 'expo-router';
import * as Linking from 'expo-linking';
import PageProvider from '@/src/components/page-provider';
import { ChevronLeft } from 'lucide-react-native';
import { goBackOrReplace } from '@/src/lib/navigation';
import { checkEmailExists, normalizeAuthEmail, sendPasswordResetEmail } from '@/src/lib/api/auth';

function isDuplicateEmailError(error: unknown): boolean {
    if (!error || typeof error !== 'object' || !('message' in error)) return false;
    const message = String(error.message).toLowerCase();
    return (
        message.includes('already registered') ||
        message.includes('already exists') ||
        message.includes('user already')
    );
}

export default function RegisterScreen() {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [agree, setAgree] = useState(false);
    const [loading, setLoading] = useState(false);
    const [isSendingReset, setIsSendingReset] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [successMessage, setSuccessMessage] = useState<string | null>(null);
    const [canResetPassword, setCanResetPassword] = useState(false);
    const router = useRouter();

    async function handleRegister() {
        const normalizedEmail = normalizeAuthEmail(email);

        if (!agree) {
            setError("You must agree to the terms and conditions.");
            setSuccessMessage(null);
            setCanResetPassword(false);
            return;
        }

        if (!normalizedEmail) {
            setError('E-posta adresi zorunlu.');
            setSuccessMessage(null);
            setCanResetPassword(false);
            return;
        }

        if (password.length < 6) {
            setError('Şifre en az 6 karakter olmalı.');
            setSuccessMessage(null);
            setCanResetPassword(false);
            return;
        }

        setLoading(true);
        setError(null);
        setSuccessMessage(null);
        setCanResetPassword(false);

        try {
            const existingEmail = await checkEmailExists(normalizedEmail);
            if (existingEmail) {
                setError('Bu mail zaten kullanımda. Şifrenizi sıfırlamak için aşağıdaki butona tıklayın.');
                setCanResetPassword(true);
                return;
            }

            const { data, error: signUpError } = await supabase.auth.signUp({
                email: normalizedEmail,
                password,
                options: {
                    emailRedirectTo: Linking.createURL('/login'),
                },
            });

            if (signUpError) {
                if (isDuplicateEmailError(signUpError)) {
                    setError('Bu mail zaten kullanımda. Şifrenizi sıfırlamak için aşağıdaki butona tıklayın.');
                    setCanResetPassword(true);
                    return;
                }

                setError(signUpError.message);
                return;
            }

            if (data.session) {
                router.replace('/home');
                return;
            }

            setSuccessMessage('Üyelik oluşturuldu. Devam etmek için e-postanı doğrulaman gerekebilir.');
        } catch (lookupError) {
            setError(
                lookupError instanceof Error && lookupError.message.startsWith('email_status_failed')
                    ? 'E-posta kontrolü şu an yapılamıyor. Lütfen biraz sonra tekrar deneyin.'
                    : 'Üyelik oluşturulamadı. Lütfen biraz sonra tekrar deneyin.'
            );
        } finally {
            setLoading(false);
        }
    }

    async function handleSendResetEmail() {
        const normalizedEmail = normalizeAuthEmail(email);
        if (!normalizedEmail) {
            setError('Şifre sıfırlama için e-posta adresini yaz.');
            setSuccessMessage(null);
            return;
        }

        setIsSendingReset(true);
        setError(null);
        setSuccessMessage(null);

        try {
            await sendPasswordResetEmail(normalizedEmail);
            setSuccessMessage('Şifre sıfırlama bağlantısı e-postana gönderildi.');
            setCanResetPassword(false);
        } catch (resetError) {
            setError(resetError instanceof Error ? resetError.message : 'Şifre sıfırlama e-postası gönderilemedi.');
        } finally {
            setIsSendingReset(false);
        }
    }

    return (
        <PageProvider>
            <ScrollView
                contentContainerClassName='flex flex-1 justify-center'
                className="flex-1">
                <View className="gap-6">
                    <View className='mb-4'>
                        <TouchableOpacity onPress={() => goBackOrReplace(router, "/")}>
                            <ChevronLeft size={24} />
                        </TouchableOpacity>
                    </View>
                    <RNImage
                        style={{ width: 48, height: 48 }}
                        source={require("@/assets/real assets/mainLogo.png")}
                    />
                    <View>
                        <Text className="text-2xl font-bold mb-2">
                            Create Account
                        </Text>
                        <Text>
                            Join Smart Gallery to organize and search the moments in your photos
                        </Text>
                    </View>

                    <TextField isRequired isInvalid={!!error && error.includes('email')}>
                        <TextField.Label>Email</TextField.Label>
                        <TextField.Input
                            placeholder="example@mail.com"
                            value={email}
                            onChangeText={setEmail}
                            autoCapitalize="none"
                            keyboardType="email-address"
                        />
                    </TextField>

                    <TextField isRequired isInvalid={!!error && error.includes('password')}>
                        <TextField.Label>Password</TextField.Label>
                        <TextField.Input
                            placeholder="Min. 6 characters"
                            secureTextEntry
                            value={password}
                            onChangeText={setPassword}
                        />
                    </TextField>

                    <FormField
                        className='p-4 bg-foreground/5 rounded-md'
                        isSelected={agree}
                        onSelectedChange={setAgree}
                        isInvalid={!!error && !agree}
                    >
                        <View className="flex-row items-center gap-2">
                            <View className="flex-1">
                                <FormField.Label>I agree to the terms</FormField.Label>
                                <FormField.Description>
                                    By checking this, you agree to the Smart Gallery Terms of Service.
                                </FormField.Description>
                            </View>
                            <FormField.Indicator variant="checkbox">
                                <Checkbox />
                            </FormField.Indicator>
                        </View>
                        {error && !agree && <FormField.ErrorMessage>{error}</FormField.ErrorMessage>}
                    </FormField>

                    <Button
                        variant="primary"
                        onPress={handleRegister}
                        isDisabled={loading}
                        className="mt-2"
                    >
                        <Button.Label>
                            {loading ? 'Creating account...' : 'Register'}
                        </Button.Label>
                    </Button>

                    <View className="flex-row justify-center items-center gap-2 mt-4">
                        <View className="flex-row gap-1">
                            <Text>Already have an account?</Text>
                            <Link href="/login">
                                <Text className="text-primary font-bold">
                                    Login
                                </Text>
                            </Link>
                        </View>
                    </View>

                    {/* Generic Error Message if it's not field-specific */}
                    {error && agree && (
                        <Text className="text-danger text-center mt-2">{error}</Text>
                    )}

                    {canResetPassword ? (
                        <TouchableOpacity
                            onPress={handleSendResetEmail}
                            disabled={isSendingReset}
                            className="items-center"
                        >
                            <Text className="text-primary font-bold">
                                {isSendingReset ? 'Gönderiliyor...' : 'Şifre sıfırlama bağlantısı gönder'}
                            </Text>
                        </TouchableOpacity>
                    ) : null}

                    {successMessage ? (
                        <Text className="text-success text-center mt-2">{successMessage}</Text>
                    ) : null}
                </View>
            </ScrollView>
        </PageProvider>
    );
}
