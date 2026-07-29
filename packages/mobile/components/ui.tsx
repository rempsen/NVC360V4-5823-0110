import {
  View,
  Text,
  ActivityIndicator,
  StyleSheet,
  Pressable,
  Image,
  PressableProps,
} from "react-native";
import * as Haptics from "expo-haptics";
import { C, STATUS, initials, assetUrl } from "../lib/theme";

export function StatusBadge({ status }: { status: string }) {
  const m = STATUS[status] ?? { label: status, color: C.sub, bg: C.bg3 };
  return (
    <View style={[s.badge, { backgroundColor: m.bg }]}>
      <View style={[s.dot, { backgroundColor: m.color }]} />
      <Text style={[s.badgeText, { color: m.color }]}>{m.label}</Text>
    </View>
  );
}

export function Avatar({
  name,
  photoUrl,
  color,
  size = 44,
}: {
  name?: string | null;
  photoUrl?: string | null;
  color?: string | null;
  size?: number;
}) {
  const url = assetUrl(photoUrl);
  if (url) {
    return (
      <Image
        source={{ uri: url }}
        style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: C.bg3 }}
      />
    );
  }
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color || C.brand,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ color: "#04121c", fontWeight: "800", fontSize: size * 0.38 }}>
        {initials(name)}
      </Text>
    </View>
  );
}

export function Card({
  children,
  style,
  onPress,
}: {
  children: React.ReactNode;
  style?: any;
  onPress?: () => void;
}) {
  const inner = <View style={[s.card, style]}>{children}</View>;
  if (onPress)
    return (
      <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}>
        {inner}
      </Pressable>
    );
  return inner;
}

type BtnProps = PressableProps & {
  title: string;
  variant?: "primary" | "ghost" | "danger" | "success" | "outline";
  loading?: boolean;
  icon?: React.ReactNode;
  small?: boolean;
};

export function Button({
  title,
  variant = "primary",
  loading,
  icon,
  small,
  disabled,
  style,
  onPress,
  accessibilityLabel,
  accessibilityRole,
  ...rest
}: BtnProps) {
  const palette: Record<string, { bg: string; fg: string; border?: string }> = {
    primary: { bg: C.brand, fg: "#04121c" },
    success: { bg: C.green, fg: "#03130d" },
    danger: { bg: C.red, fg: "#fff" },
    ghost: { bg: "transparent", fg: C.sub },
    outline: { bg: "transparent", fg: C.text, border: C.borderHi },
  };
  const p = palette[variant];
  // Small tactile confirmation on every tap — the kind of polish detail that
  // makes an app feel responsive/premium rather than just functional. Skipped
  // for destructive-feeling states (disabled/loading) since nothing happened.
  const handlePress = (e: any) => {
    if (!disabled && !loading) {
      Haptics.impactAsync(
        variant === "danger" ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light,
      ).catch(() => {});
    }
    onPress?.(e);
  };
  return (
    <Pressable
      disabled={disabled || loading}
      onPress={handlePress}
      // Screen-reader support: every Button gets a sensible default label/role
      // for free (VoiceOver/TalkBack) unless the caller overrides it — this is
      // the single highest-leverage place to fix it since nearly every
      // tappable action in the app goes through this component.
      accessibilityRole={accessibilityRole ?? "button"}
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: !!(disabled || loading), busy: !!loading }}
      style={({ pressed }) => [
        s.btn,
        small && s.btnSmall,
        {
          backgroundColor: p.bg,
          borderColor: p.border ?? "transparent",
          borderWidth: p.border ? 1 : 0,
          opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
        },
        style as any,
      ]}
      {...rest}
    >
      {loading ? (
        <ActivityIndicator color={p.fg} size="small" />
      ) : (
        <>
          {icon}
          <Text style={[s.btnText, small && { fontSize: 13 }, { color: p.fg }]}>{title}</Text>
        </>
      )}
    </Pressable>
  );
}

export function FullLoader({ label }: { label?: string }) {
  return (
    <View style={s.loader}>
      <ActivityIndicator color={C.brand} size="large" />
      {label ? <Text style={s.loaderText}>{label}</Text> : null}
    </View>
  );
}

export function Empty({ icon, text, sub }: { icon?: React.ReactNode; text: string; sub?: string }) {
  return (
    <View style={s.empty}>
      {icon}
      <Text style={s.emptyText}>{text}</Text>
      {sub ? <Text style={s.emptySub}>{sub}</Text> : null}
    </View>
  );
}

export function Row({ label, value }: { label: string; value?: string | null }) {
  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={s.rowValue}>{value || "—"}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    alignSelf: "flex-start",
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  badgeText: { fontSize: 12, fontWeight: "700" },
  card: {
    backgroundColor: C.card,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: C.border,
    padding: 16,
  },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 18,
  },
  btnSmall: { paddingVertical: 9, paddingHorizontal: 14, borderRadius: 11 },
  btnText: { fontSize: 15, fontWeight: "700" },
  loader: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, paddingVertical: 60 },
  loaderText: { color: C.sub, fontSize: 14 },
  empty: { alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 56 },
  emptyText: { color: C.text, fontSize: 15, fontWeight: "600" },
  emptySub: { color: C.muted, fontSize: 13 },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    gap: 16,
  },
  rowLabel: { color: C.muted, fontSize: 13 },
  rowValue: { color: C.text, fontSize: 14, fontWeight: "600", flexShrink: 1, textAlign: "right" },
});
