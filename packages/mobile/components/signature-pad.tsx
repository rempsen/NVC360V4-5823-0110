/**
 * On-site signature capture — zero native dependencies.
 *
 * Strokes are collected with PanResponder as plain [x, y] point arrays and
 * POSTed to the API, which renders them into an SVG server-side. Doing it this
 * way (instead of react-native-signature-canvas / webview / react-native-svg)
 * means signature capture ships in an over-the-air update — no new binary
 * build required — and the stored asset is a crisp vector at any size.
 *
 * The live preview is drawn with plain <View> segments: each pair of
 * consecutive points becomes a thin rotated rectangle. Cheap, and good enough
 * for the 2-3 second feedback loop of signing.
 */
import { useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  PanResponder,
  Pressable,
  TextInput,
  ActivityIndicator,
  LayoutChangeEvent,
} from "react-native";
import { R } from "../lib/theme";

type Point = [number, number];

const PAD_HEIGHT = 180;
const STROKE = 2.5;

function Segment({ a, b, color }: { a: Point; b: Point; color: string }) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.max(1, Math.hypot(dx, dy));
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: a[0],
        top: a[1] - STROKE / 2,
        width: len,
        height: STROKE,
        borderRadius: STROKE / 2,
        backgroundColor: color,
        transform: [{ translateX: 0 }, { translateY: 0 }, { rotateZ: `${angle}deg` }],
        transformOrigin: "left center",
      }}
    />
  );
}

export function SignaturePad({
  onSubmit,
  submitting,
  colors,
}: {
  /** Resolves when the signature has been persisted. */
  onSubmit: (payload: {
    strokes: Point[][];
    width: number;
    height: number;
    name: string;
  }) => Promise<void>;
  submitting?: boolean;
  colors: { bg: string; card: string; text: string; muted: string; brand: string; line: string };
}) {
  const [strokes, setStrokes] = useState<Point[][]>([]);
  const [name, setName] = useState("");
  const [width, setWidth] = useState(320);
  const current = useRef<Point[]>([]);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => {
          current.current = [[e.nativeEvent.locationX, e.nativeEvent.locationY]];
          setStrokes((s) => [...s, current.current]);
        },
        onPanResponderMove: (e) => {
          const pt: Point = [e.nativeEvent.locationX, e.nativeEvent.locationY];
          const last = current.current[current.current.length - 1];
          // drop sub-pixel jitter so the payload stays small
          if (last && Math.hypot(pt[0] - last[0], pt[1] - last[1]) < 1.2) return;
          current.current.push(pt);
          setStrokes((s) => [...s.slice(0, -1), [...current.current]]);
        },
        onPanResponderRelease: () => {
          current.current = [];
        },
      }),
    [],
  );

  const hasInk = strokes.some((st) => st.length > 1);
  const canSubmit = hasInk && name.trim().length > 1 && !submitting;

  return (
    <View style={{ gap: 10 }}>
      <View
        onLayout={(e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width))}
        {...pan.panHandlers}
        style={[st.pad, { borderColor: colors.line }]}
        accessibilityLabel="Signature pad — sign with your finger"
      >
        {strokes.map((stroke, si) =>
          stroke.slice(1).map((pt, i) => (
            <Segment key={`${si}-${i}`} a={stroke[i]!} b={pt} color="#0f172a" />
          )),
        )}
        {!hasInk && <Text style={st.hint}>Sign here</Text>}
      </View>

      <TextInput
        value={name}
        onChangeText={setName}
        placeholder="Printed name of person signing"
        placeholderTextColor={colors.muted}
        style={[st.input, { color: colors.text, borderColor: colors.line, backgroundColor: colors.card }]}
        accessibilityLabel="Printed name of the person signing"
      />

      <View style={{ flexDirection: "row", gap: 10 }}>
        <Pressable
          onPress={() => setStrokes([])}
          style={[st.btn, { borderColor: colors.line }]}
          accessibilityRole="button"
          accessibilityLabel="Clear signature"
        >
          <Text style={{ color: colors.muted, fontWeight: "700", fontSize: 13 }}>Clear</Text>
        </Pressable>
        <Pressable
          disabled={!canSubmit}
          onPress={() =>
            onSubmit({ strokes, width, height: PAD_HEIGHT, name: name.trim() }).then(() => {
              setStrokes([]);
              setName("");
            })
          }
          style={[
            st.btn,
            { flex: 1, backgroundColor: canSubmit ? colors.brand : colors.line, borderColor: "transparent" },
          ]}
          accessibilityRole="button"
          accessibilityLabel="Save signature"
        >
          {submitting ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={{ color: "#fff", fontWeight: "800", fontSize: 13 }}>Save signature</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  pad: {
    height: PAD_HEIGHT,
    borderRadius: R.control,
    borderWidth: 1,
    backgroundColor: "#ffffff",
    overflow: "hidden",
    justifyContent: "center",
    alignItems: "center",
  },
  hint: { color: "#94a3b8", fontSize: 13, fontWeight: "600" },
  input: {
    borderWidth: 1,
    borderRadius: R.control,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  btn: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: R.control,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
