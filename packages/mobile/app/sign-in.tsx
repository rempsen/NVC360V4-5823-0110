import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Pressable,
  Linking,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import Constants from "expo-constants";
import { authClient, captureToken } from "../lib/auth";
import { C } from "../lib/theme";
import { Button } from "../components/ui";

const API = ((Constants.expoConfig?.extra?.apiUrl as string) ?? "").replace(/\/$/, "");

export default function SignIn() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!email.trim() || !password) {
      setError("Enter your email and password");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await authClient.signIn.email(
        { email: email.trim(), password },
        { onSuccess: captureToken }
      );
      if (res.error) {
        setError(res.error.message || "Sign in failed");
        setLoading(false);
        return;
      }
      // Straight to the company picker — it self-skips for anyone on a single
      // company's roster, and it forwards to onboarding when that's still due,
      // so this one destination is correct for every driver.
      router.replace("/pick-company");
    } catch (e: any) {
      setError(e?.message || "Something went wrong");
      setLoading(false);
    }
  }

  return (
    <SafeAreaView style={s.safe} edges={["top", "left", "right", "bottom"]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={s.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={s.brandWrap}>
            <Image source={require("../assets/nvc-logo.png")} style={s.logo} resizeMode="contain" />
            <Text style={s.kicker}>Technician App</Text>
            <Text style={s.title}>Sign in to your shift</Text>
            <Text style={s.sub}>Jobs, routes, and earnings — all in one place.</Text>
          </View>

          <View style={s.form}>
            <Text style={s.label}>Email</Text>
            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder="you@nvc360.app"
              placeholderTextColor={C.muted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              style={s.input}
              accessibilityLabel="Email address"
            />

            <Text style={[s.label, { marginTop: 16 }]}>Password</Text>
            <TextInput
              value={password}
              onChangeText={setPassword}
              placeholder="••••••••"
              placeholderTextColor={C.muted}
              secureTextEntry
              style={s.input}
              onSubmitEditing={submit}
              accessibilityLabel="Password"
            />

            {error ? <Text style={s.error}>{error}</Text> : null}

            <Button title="Sign in" loading={loading} onPress={submit} style={{ marginTop: 22 }} />

            <Pressable
              onPress={() => Linking.openURL(`${API}/forgot-password`)}
              style={s.forgotWrap}
              accessibilityRole="link"
              accessibilityLabel="Forgot password"
            >
              <Text style={s.forgotText}>Forgot password?</Text>
            </Pressable>
          </View>

          <Text style={s.foot}>NVC360 · Field Operations</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  forgotWrap: { alignSelf: "center", marginTop: 18, padding: 8 },
  forgotText: { color: C.brand, fontSize: 13, fontWeight: "700" },
  safe: { flex: 1, backgroundColor: C.bg },
  scroll: { flexGrow: 1, justifyContent: "center", padding: 24, gap: 36 },
  brandWrap: { alignItems: "center", gap: 6 },
  logo: { width: 150, height: 64, marginBottom: 14 },
  kicker: {
    color: C.brand,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 2,
    textTransform: "uppercase",
  },
  title: { color: C.text, fontSize: 26, fontWeight: "800", textAlign: "center" },
  sub: { color: C.sub, fontSize: 14, textAlign: "center", maxWidth: 280 },
  form: {
    backgroundColor: C.card,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: C.border,
    padding: 22,
  },
  label: { color: C.sub, fontSize: 13, fontWeight: "600", marginBottom: 8 },
  input: {
    backgroundColor: C.bg3,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 13,
    paddingHorizontal: 15,
    paddingVertical: 14,
    color: C.text,
    fontSize: 15,
  },
  error: { color: C.red, fontSize: 13, marginTop: 14, fontWeight: "600" },
  foot: { color: C.muted, fontSize: 12, textAlign: "center", letterSpacing: 1 },
});
