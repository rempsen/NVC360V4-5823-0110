import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveActivity } from "../../lib/useLiveActivity";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Linking,
  Alert,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Image,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as Location from "expo-location";
import * as ImagePicker from "expo-image-picker";
import Constants from "expo-constants";
import {
  CaretLeft,
  CaretDown,
  CaretUp,
  NavigationArrow,
  Phone,
  ChatText,
  MapPin,
  Camera,
  PaperPlaneRight,
  CheckSquare,
  Square,
  User,
  Clock,
  Headset,
  Ruler,
  Warning,
  Info,
  Note,
  Tag,
  Car,
  CheckCircle,
  PencilSimple,
  Buildings,
} from "phosphor-react-native";
import { api } from "../../lib/api";
import { useCustomerNoun, useJobNoun } from "../../lib/use-brand";
import { getToken } from "../../lib/auth";
import { C, money, fmtDate, assetUrl } from "../../lib/theme";
import { StatusBadge, Button, FullLoader } from "../../components/ui";

const API = ((Constants.expoConfig?.extra?.apiUrl as string) ?? "").replace(/\/$/, "");

// status -> next manual action.
// "Start driving"  → enroute  (triggers on-my-way SMS to customer)
// "I've Arrived"   → arrived  (manual fallback; geofence auto-arrives at 150m)
// "Complete job"   → completed
// NOTE: "Complete job" must NEVER appear while status is enroute — driver must arrive first.
const FLOW: Record<string, { next: string; label: string; variant: any; hint?: string }> = {
  assigned:    { next: "enroute",   label: "Start Driving",  variant: "primary" },
  enroute:     { next: "arrived",   label: "I've Arrived",   variant: "primary",
                 hint: "Auto-arrives when you're within 150m of the address. Tap if not auto-detected." },
  arrived:     { next: "completed", label: "Complete Job",   variant: "success" },
  in_progress: { next: "completed", label: "Complete Job",   variant: "success" },
};

// states where we keep pinging GPS (drives mileage + geofence auto-arrive/clock)
const ACTIVE_PING = new Set(["enroute", "arrived", "in_progress"]);

function fmtMinutes(min: number | undefined | null): string {
  const m = Math.round(min ?? 0);
  if (m <= 0) return "—";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

export default function JobDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const { noun: customerNoun } = useCustomerNoun();
  const { noun: jobNoun } = useJobNoun();
  
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [msg, setMsg] = useState("");
  const [dispatchMsg, setDispatchMsg] = useState("");
  const [driverNote, setDriverNote] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [_showDebrief, _setShowDebrief] = useState(false);
  // collapsible section state
  const [dispatchExpanded, setDispatchExpanded] = useState(false);
  const [customerExpanded, setCustomerExpanded] = useState(false);
  const [driverNoteExpanded, setDriverNoteExpanded] = useState(false);

  const job = useQuery({
    queryKey: ["job", id],
    queryFn: async () => {
      const res = await api.bookings[":id"].$get({ param: { id: id! } });
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).booking as any;
    },
    refetchInterval: 15000,
  });

  const messages = useQuery({
    queryKey: ["messages", id],
    queryFn: async () => {
      const res = await api.messages[":bookingId"].$get({ param: { bookingId: id! } });
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).messages as any[];
    },
    refetchInterval: 8000,
  });

  const photos = useQuery({
    queryKey: ["photos", id],
    queryFn: async () => {
      const res = await api.bookings[":id"].photos.$get({ param: { id: id! } });
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).photos as any[];
    },
  });

  const setStatus = useMutation({
    mutationFn: async (status: string) => {
      const res = await api.bookings[":id"].status.$post({ param: { id: id! }, json: { status } } as any);
      if (!res.ok) throw new Error("Failed");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["job", id] }),
  });

  const toggleChecklist = useMutation({
    mutationFn: async ({ index, done }: { index: number; done: boolean }) => {
      const res = await fetch(`${API}/api/bookings/${id}/checklist`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ index, done }),
      });
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<{ checklist: any[] }>;
    },
    onSuccess: (data) => {
      // optimistic update
      qc.setQueryData(["job", id], (old: any) =>
        old ? { ...old, checklistState: JSON.stringify(data.checklist) } : old
      );
    },
  });

  const directThread = useQuery({
    queryKey: ["dispatch-thread"],
    queryFn: async () => {
      const res = await fetch(`${API}/api/messages/direct`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<{ direct: any[]; job: any }>;
    },
    refetchInterval: 6000,
  });

  const sendMsg = useMutation({
    mutationFn: async (body: string) => {
      const res = await api.messages[":bookingId"].$post({ param: { bookingId: id! }, json: { body } } as any);
      if (!res.ok) throw new Error("Failed");
    },
    onSuccess: () => {
      setMsg("");
      qc.invalidateQueries({ queryKey: ["messages", id] });
    },
  });

  const sendDispatch = useMutation({
    mutationFn: async (body: string) => {
      const res = await fetch(`${API}/api/messages/direct`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) throw new Error("Failed");
    },
    onSuccess: () => {
      setDispatchMsg("");
      qc.invalidateQueries({ queryKey: ["dispatch-thread"] });
    },
  });

  const saveDriverNote = async () => {
    if (!driverNote.trim()) return;
    setSavingNote(true);
    try {
      const res = await fetch(`${API}/api/bookings/${id}/driver-notes`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ notes: driverNote.trim() }),
      });
      if (res.ok) {
        qc.invalidateQueries({ queryKey: ["job", id] });
        Alert.alert("Saved", "Your field note has been saved to the job record.");
      } else {
        Alert.alert("Error", "Could not save note. Try again.");
      }
    } catch {
      Alert.alert("Error", "Network error. Try again.");
    } finally {
      setSavingNote(false);
    }
  };

  // Live Activity / Dynamic Island — iOS 16.2+
  const { updateEta } = useLiveActivity(
    job.data
      ? {
          jobId: id ?? "",
          clientName: job.data.customerName ?? job.data.clientName ?? "",
          address: job.data.address ?? "",
          status: job.data.status,
          etaMins: job.data.etaMins ?? null,
        }
      : null
  );

  // live location ping while enroute
  // Pre-fill driver note textarea with any existing saved note
  useEffect(() => {
    if (job.data?.driverNotes && !driverNote) {
      setDriverNote(job.data.driverNotes);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.data?.driverNotes, driverNote]);

  // Auto-expand dispatch if there are unread messages
  useEffect(() => {
    const unread = (directThread.data?.direct ?? []).filter(
      (m: any) => m.senderRole === "dispatch" && !m.read
    ).length;
    if (unread > 0) setDispatchExpanded(true);
  }, [directThread.data]);

  useEffect(() => {
    const status = job.data?.status;
    async function startPings() {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (!perm.granted) return;
      const ping = async () => {
        try {
          const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
          const res = await fetch(`${API}/api/tracking/${id}/ping`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
            body: JSON.stringify({ lat: loc.coords.latitude, lng: loc.coords.longitude }),
          });
          // Update Live Activity ETA if server returns one
          if (res.ok) {
            const data = await res.json().catch(() => null);
            if (data?.etaMins != null) updateEta(data.etaMins);
          }
        } catch {}
      };
      ping();
      pingTimer.current = setInterval(ping, 8000);
    }
    if (status && ACTIVE_PING.has(status)) startPings();
    return () => {
      if (pingTimer.current) clearInterval(pingTimer.current);
      pingTimer.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.data?.status, id]);

  const navigate = useCallback(() => {
    const j = job.data;
    if (!j) return;
    const q = j.lat && j.lng ? `${j.lat},${j.lng}` : encodeURIComponent(j.address);
    const url = Platform.select({
      ios: `http://maps.apple.com/?daddr=${q}`,
      default: `https://www.google.com/maps/dir/?api=1&destination=${q}`,
    })!;
    Linking.openURL(url);
  }, [job.data]);

  // open native SMS app to text the customer directly (works even if they
  // never opened the tracking link). Optional prefilled body.
  const textCustomer = useCallback(
    (body?: string) => {
      const j = job.data;
      const phone = (j?.customer?.phone || j?.customerPhone || "").replace(/[^\d+]/g, "");
      if (!phone) {
        Alert.alert("No phone number", "This customer has no phone number on file.");
        return;
      }
      const sep = Platform.OS === "ios" ? "&" : "?";
      const url = body
        ? `sms:${phone}${sep}body=${encodeURIComponent(body)}`
        : `sms:${phone}`;
      Linking.openURL(url).catch(() =>
        Alert.alert("Can't open Messages", "No SMS app available on this device."),
      );
    },
    [job.data],
  );

  async function capturePhoto() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Camera needed", "Allow camera to attach job photos.");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.6 });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", {
        uri: asset.uri,
        name: asset.fileName || "job.jpg",
        type: asset.mimeType || "image/jpeg",
      } as any);
      const res = await fetch(`${API}/api/bookings/${id}/photos`, {
        method: "POST",
        headers: { Authorization: `Bearer ${getToken()}` },
        body: form,
      });
      if (!res.ok) throw new Error("Upload failed");
      await qc.invalidateQueries({ queryKey: ["photos", id] });
    } catch (e: any) {
      Alert.alert("Upload failed", e?.message || "Try again");
    } finally {
      setUploading(false);
    }
  }

  if (job.isLoading) return <FullLoader />;
  const j = job.data;
  if (!j) return <FullLoader label="Not found" />;

  const action = FLOW[j.status];

  // friendly ETA: "12 min" or "1h 24m"; arrival clock time
  const etaMins: number | null = j.etaMins ?? null;
  const etaLabel =
    etaMins == null
      ? null
      : etaMins >= 60
        ? `${Math.floor(etaMins / 60)}h ${etaMins % 60}m`
        : `${etaMins} min`;
  const arrivalLabel =
    etaMins == null
      ? null
      : new Date(Date.now() + etaMins * 60000).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        });
  const distLabel = j.etaDistanceKm != null ? `${j.etaDistanceKm} km` : null;
  const etaSmsBody =
    etaLabel != null
      ? `Hi ${j.customer?.name?.split(" ")[0] || "there"}, this is your ${j.service?.name || "service"} technician — I'm on the way, about ${etaLabel} out${arrivalLabel ? ` (arriving ~${arrivalLabel})` : ""}.`
      : `Hi ${j.customer?.name?.split(" ")[0] || "there"}, this is your technician — I'm on the way to you now.`;
  let checklist: any[] = [];
  try { checklist = JSON.parse(j.checklistState || "[]"); } catch {}
  let fields: Record<string, any> = {};
  try { fields = JSON.parse(j.fieldData || "{}"); } catch {}
  const fieldEntries = Object.entries(fields)
    .filter(([k, v]) => v != null && v !== "" && k !== "_customFields");

  // per-unit line items — what the tech is paid by measured unit (cost = tech pay)
  let unitLines: any[] = [];
  try {
    const arr = typeof j.lineItems === "string" ? JSON.parse(j.lineItems || "[]") : j.lineItems;
    if (Array.isArray(arr)) unitLines = arr.filter((x: any) => x?.kind === "unit");
  } catch {}
  const unitPayTotal = unitLines.reduce((sum, l) => sum + (Number(l.cost) || 0), 0);

  return (
    <SafeAreaView style={s.safe} edges={["top", "left", "right"]}>
      <View style={s.topbar}>
        <Pressable onPress={() => router.back()} style={s.backBtn} hitSlop={10} accessibilityRole="button" accessibilityLabel="Go back">
          <CaretLeft color={C.text} size={22} />
        </Pressable>
        <Text style={s.topTitle} numberOfLines={1}>{j.service?.name || j.title || jobNoun}</Text>
        <View style={{ width: 40 }} />
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={80}
      >
        <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
          <View style={s.statusRow}>
            <StatusBadge status={j.status} />
            <Text style={s.price}>{money(j.price)}</Text>
          </View>

          {/* Job Progress Stepper */}
          {!["completed","cancelled"].includes(j.status) && (
            <View style={s.stepperCard}>
              {[
                { key: "assigned",    icon: <Car color={["assigned"].includes(j.status) ? C.brand : C.green} size={16} weight="fill" />,    label: "Assigned" },
                { key: "enroute",     icon: <NavigationArrow color={["enroute"].includes(j.status) ? C.brand : (["arrived","in_progress","completed"].includes(j.status) ? C.green : C.muted)} size={16} weight="fill" />, label: "En Route" },
                { key: "arrived",     icon: <MapPin color={["arrived","in_progress"].includes(j.status) ? C.brand : (["completed"].includes(j.status) ? C.green : C.muted)} size={16} weight="fill" />,    label: "On Site" },
                { key: "completed",   icon: <CheckCircle color={j.status === "completed" ? C.green : C.muted} size={16} weight="fill" />, label: "Done" },
              ].map((step, idx, arr) => {
                const ORDERED = ["assigned","enroute","arrived","in_progress","completed"];
                const curIdx = ORDERED.indexOf(j.status);
                const stepIdx = ORDERED.indexOf(step.key);
                const isDone = stepIdx < curIdx;
                const isActive = step.key === j.status || (step.key === "arrived" && j.status === "in_progress");
                return (
                  <View key={step.key} style={{ flexDirection: "row", alignItems: "center", flex: idx < arr.length - 1 ? 1 : undefined }}>
                    <View style={[s.stepDot, isDone && s.stepDotDone, isActive && s.stepDotActive]}>
                      {step.icon}
                    </View>
                    <View style={{ alignItems: "center", position: "absolute", top: 28, left: -20, width: 60 }}>
                      <Text style={[s.stepLabel, isActive && { color: C.brand, fontWeight: "700" }, isDone && { color: C.green }]}>{step.label}</Text>
                    </View>
                    {idx < arr.length - 1 && (
                      <View style={[s.stepLine, isDone && s.stepLineDone]} />
                    )}
                  </View>
                );
              })}
            </View>
          )}

          {/* Customer */}
          <View style={s.block}>
            <View style={s.custRow}>
              <View style={s.custIcon}><User color={C.brand} size={20} weight="fill" /></View>
              <View style={{ flex: 1 }}>
                <Text style={s.custName}>{j.customer?.name || customerNoun}</Text>
                <Text style={s.custMeta}>{fmtDate(j.scheduledAt)}</Text>
              </View>
              {(j.customer?.phone || j.customerPhone) ? (
                <View style={s.contactBtns}>
                  <Pressable
                    onPress={() => Linking.openURL(`tel:${j.customer?.phone || j.customerPhone}`)}
                    style={s.iconBtn}
                    accessibilityRole="button"
                    accessibilityLabel={`Call ${customerNoun.toLowerCase()}`}
                  >
                    <Phone color={C.brand} size={19} weight="fill" />
                  </Pressable>
                  <Pressable onPress={() => textCustomer()} style={s.iconBtn} accessibilityRole="button" accessibilityLabel={`Text ${customerNoun.toLowerCase()}`}>
                    <ChatText color={C.brand} size={19} weight="fill" />
                  </Pressable>
                </View>
              ) : null}
            </View>
          </View>

          {/* Address + navigate */}
          <View style={s.block}>
            <View style={s.addrRow}>
              <MapPin color={C.sub} size={18} />
              <Text style={s.addr}>{j.address}</Text>
            </View>
            <Button
              title="Navigate"
              icon={<NavigationArrow color="#04121c" size={18} weight="fill" />}
              onPress={navigate}
              style={{ marginTop: 12 }}
            />
            {j.status === "enroute" && (
              <>
                <View style={s.liveRow}>
                  <View style={s.liveDot} />
                  <Text style={s.liveTxt}>Sharing live location with customer</Text>
                </View>

                {/* Tech's own live ETA — so they can relay it by call/text */}
                <View style={s.etaCard}>
                  <View style={s.etaMain}>
                    <Clock color={C.cyan} size={22} weight="fill" />
                    <View style={{ flex: 1 }}>
                      <Text style={s.etaBig}>
                        {etaLabel ? `${etaLabel} away` : "Calculating ETA…"}
                      </Text>
                      <Text style={s.etaSub}>
                        {arrivalLabel ? `Arriving ~${arrivalLabel}` : "Updates as you drive"}
                        {distLabel ? ` · ${distLabel}` : ""}
                      </Text>
                    </View>
                  </View>
                  <Pressable onPress={() => textCustomer(etaSmsBody)} style={s.etaTextBtn}>
                    <ChatText color="#04121c" size={16} weight="fill" />
                    <Text style={s.etaTextBtnTxt}>Text ETA</Text>
                  </Pressable>
                </View>
                <Text style={s.geoHint}>
                  You'll be checked in automatically when you reach the address.
                </Text>
              </>
            )}

            {/* Auto-arrived: geofenced on-site clock */}
            {(j.status === "arrived" || j.status === "in_progress") && (
              <View
                style={[
                  s.clockCard,
                  j.clockState === "paused" && s.clockCardPaused,
                ]}
              >
                <Clock
                  color={j.clockState === "paused" ? C.muted : C.green}
                  size={22}
                  weight="fill"
                />
                <View style={{ flex: 1 }}>
                  <Text style={s.clockBig}>
                    {j.clockState === "paused" ? "Clock paused" : "On site · clock running"}
                  </Text>
                  <Text style={s.clockSub}>
                    {j.clockState === "paused"
                      ? "You've stepped away from the job site — time isn't counting. Return to resume."
                      : `Checked in automatically${
                          typeof j.onSiteMinutes === "number" && j.onSiteMinutes > 0
                            ? ` · ${j.onSiteMinutes} min banked`
                            : ""
                        }`}
                  </Text>
                </View>
              </View>
            )}

            {/* Trip stats: transit time, on-site time, mileage — visible from enroute onward */}
            {j.enrouteAt && (
              <View style={s.statsRow}>
                <View style={s.statCard}>
                  <Car color={C.cyan} size={18} weight="fill" />
                  <Text style={s.statVal}>{fmtMinutes(j.transitMinutes)}</Text>
                  <Text style={s.statLbl}>Transit</Text>
                </View>
                <View style={s.statCard}>
                  <Clock
                    color={j.clockState === "paused" ? C.muted : C.green}
                    size={18}
                    weight="fill"
                  />
                  <Text style={s.statVal}>
                    {typeof j.onSiteMinutes === "number" ? fmtMinutes(j.onSiteMinutes) : "—"}
                  </Text>
                  <Text style={s.statLbl}>
                    {j.clockState === "paused" ? "On site (paused)" : "On site"}
                  </Text>
                </View>
                <View style={s.statCard}>
                  <Ruler color={C.cyan} size={18} weight="fill" />
                  <Text style={s.statVal}>
                    {typeof j.mileageKm === "number" ? `${j.mileageKm.toFixed(1)} km` : "—"}
                  </Text>
                  <Text style={s.statLbl}>Mileage</Text>
                </View>
              </View>
            )}
          </View>

          {/* Staff Notes — internal, driver-only */}
          {j.staffNotes ? (
            <View style={[s.block, s.staffNotesBlock]}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 7, marginBottom: 8 }}>
                <Warning color="#f59e0b" size={16} weight="fill" />
                <Text style={[s.blockTitle, { color: "#f59e0b" }]}>Staff Notes (Dispatcher Only)</Text>
              </View>
              <Text style={s.staffNotesText}>{j.staffNotes}</Text>
            </View>
          ) : null}

          {/* Notes (customer-facing) */}
          {j.notes ? (
            <View style={s.block}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 7, marginBottom: 8 }}>
                <Note color={C.sub} size={14} weight="fill" />
                <Text style={s.blockTitle}>{jobNoun} Notes</Text>
              </View>
              <Text style={s.notes}>{j.notes}</Text>
            </View>
          ) : null}

          {/* Rich Job Details */}
          <View style={s.block}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 7, marginBottom: 10 }}>
              <Info color={C.sub} size={14} weight="fill" />
              <Text style={s.blockTitle}>{jobNoun} Details</Text>
            </View>
            {j.service?.name ? (
              <View style={s.fieldRow}>
                <Text style={s.fieldKey}>Service</Text>
                <Text style={s.fieldVal}>{j.service.name}</Text>
              </View>
            ) : null}
            {j.service?.description ? (
              <View style={[s.fieldRow, { flexDirection: "column", gap: 4 }]}>
                <Text style={s.fieldKey}>Description</Text>
                <Text style={[s.fieldVal, { textAlign: "left", color: C.text, fontSize: 13 }]}>{j.service.description}</Text>
              </View>
            ) : null}
            {j.priority && j.priority !== "normal" ? (
              <View style={s.fieldRow}>
                <Text style={s.fieldKey}>Priority</Text>
                <Text style={[s.fieldVal, {
                  color: j.priority === "urgent" ? "#ef4444" : j.priority === "high" ? "#f97316" : C.green,
                  textTransform: "capitalize",
                }]}>{j.priority}</Text>
              </View>
            ) : null}
            {j.service?.durationMins ? (
              <View style={s.fieldRow}>
                <Text style={s.fieldKey}>Est. Duration</Text>
                <Text style={s.fieldVal}>
                  {j.service.durationMins >= 60
                    ? `${Math.floor(j.service.durationMins / 60)}h ${j.service.durationMins % 60 > 0 ? `${j.service.durationMins % 60}m` : ""}`.trim()
                    : `${j.service.durationMins} min`}
                </Text>
              </View>
            ) : null}
            {j.service?.category ? (
              <View style={s.fieldRow}>
                <Text style={s.fieldKey}>Category</Text>
                <Text style={s.fieldVal}>{j.service.category}</Text>
              </View>
            ) : null}
            {j.region ? (
              <View style={s.fieldRow}>
                <Text style={s.fieldKey}>Region/Tax</Text>
                <Text style={s.fieldVal}>{j.region}</Text>
              </View>
            ) : null}
          </View>

          {/* Job fields (template custom fields) — typed rendering */}
          {(() => {
            // Prefer structured _customFields array for proper typed rendering
            let customFieldDefs: any[] = [];
            try { customFieldDefs = Array.isArray(fields._customFields) ? fields._customFields : []; } catch {}

            // Render typed fields
            if (customFieldDefs.length > 0) {
              return (
                <View style={s.block}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 7, marginBottom: 8 }}>
                    <Tag color={C.sub} size={14} weight="fill" />
                    <Text style={s.blockTitle}>{jobNoun} Instructions & Fields</Text>
                  </View>
                  {customFieldDefs.map((cf: any) => {
                    const val = fields[cf.id] ?? fields[cf.label];
                    if (cf.type === "instructions") {
                      return (
                        <View key={cf.id} style={[s.fieldRow, { flexDirection: "column", gap: 4, backgroundColor: "rgba(14,165,233,0.07)", borderRadius: 8, padding: 10, marginBottom: 4 }]}>
                          <Text style={[s.fieldKey, { color: C.brand }]}>📋 Instructions</Text>
                          <Text style={[s.fieldVal, { textAlign: "left", color: C.text, fontSize: 13, lineHeight: 20 }]}>{cf.body || cf.label || ""}</Text>
                        </View>
                      );
                    }
                    if (cf.type === "checkbox") {
                      const checked = val === true || val === "true";
                      return (
                        <View key={cf.id} style={s.fieldRow}>
                          <Text style={s.fieldKey}>{cf.label}</Text>
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                            {checked
                              ? <CheckSquare color={C.green} size={16} weight="fill" />
                              : <Square color={C.muted} size={16} />}
                            <Text style={[s.fieldVal, { color: checked ? C.green : C.muted }]}>
                              {checked ? "Yes" : (val != null && val !== "" ? String(val) : "Not set")}
                            </Text>
                          </View>
                        </View>
                      );
                    }
                    if (cf.type === "select") {
                      return (
                        <View key={cf.id} style={s.fieldRow}>
                          <Text style={s.fieldKey}>{cf.label}</Text>
                          <Text style={[s.fieldVal, val ? undefined : { color: C.muted }]}>
                            {val != null && val !== "" ? String(val) : "Not set"}
                          </Text>
                        </View>
                      );
                    }
                    if (cf.type === "date") {
                      return (
                        <View key={cf.id} style={s.fieldRow}>
                          <Text style={s.fieldKey}>{cf.label}</Text>
                          <Text style={[s.fieldVal, val ? undefined : { color: C.muted }]}>
                            {val ? new Date(val).toLocaleDateString() : "Not set"}
                          </Text>
                        </View>
                      );
                    }
                    if (cf.type === "flat_fee") {
                      if (cf.amount == null) return null;
                      return (
                        <View key={cf.id} style={s.fieldRow}>
                          <Text style={s.fieldKey}>{cf.label}</Text>
                          <Text style={[s.fieldVal, { color: C.brand }]}>${Number(cf.amount).toFixed(2)} flat fee</Text>
                        </View>
                      );
                    }
                    if (cf.type === "price_logic") {
                      return (
                        <View key={cf.id} style={s.fieldRow}>
                          <Text style={s.fieldKey}>{cf.label}</Text>
                          <Text style={[s.fieldVal, { color: C.brand }]}>
                            ${cf.logicRate ?? 0}/{cf.logicUnit ?? "unit"}
                            {val != null && val !== "" ? ` × ${val} = ${(Number(cf.logicRate || 0) * Number(val || 0)).toFixed(2)}` : ""}
                          </Text>
                        </View>
                      );
                    }
                    if (cf.type === "notes" || cf.type === "text") {
                      if (val == null || val === "") return null;
                      return (
                        <View key={cf.id} style={[s.fieldRow, { flexDirection: "column", gap: 4 }]}>
                          <Text style={s.fieldKey}>{cf.label}</Text>
                          <Text style={[s.fieldVal, { textAlign: "left", color: C.text, fontSize: 13 }]}>{String(val)}</Text>
                        </View>
                      );
                    }
                    if (cf.type === "number") {
                      if (val == null || val === "") return null;
                      return (
                        <View key={cf.id} style={s.fieldRow}>
                          <Text style={s.fieldKey}>{cf.label}</Text>
                          <Text style={s.fieldVal}>{String(val)}</Text>
                        </View>
                      );
                    }
                    // fallback: show label + value as text
                    if (val == null || val === "" || cf.type === "file") return null;
                    return (
                      <View key={cf.id} style={s.fieldRow}>
                        <Text style={s.fieldKey}>{cf.label}</Text>
                        <Text style={s.fieldVal}>{String(val)}</Text>
                      </View>
                    );
                  })}
                </View>
              );
            }

            // Fallback: render flat key/value pairs (old format)
            if (fieldEntries.length > 0) {
              return (
                <View style={s.block}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 7, marginBottom: 8 }}>
                    <Tag color={C.sub} size={14} weight="fill" />
                    <Text style={s.blockTitle}>Custom Fields</Text>
                  </View>
                  {fieldEntries.map(([k, v]) => (
                    <View key={k} style={s.fieldRow}>
                      <Text style={s.fieldKey}>{k}</Text>
                      <Text style={s.fieldVal}>{String(v)}</Text>
                    </View>
                  ))}
                </View>
              );
            }
            return null;
          })()}

          {/* Per-unit work & pay (tech-facing — never shown to the client) */}
          {unitLines.length > 0 && (
            <View style={s.block}>
              <View style={s.unitHead}>
                <Ruler color={C.green} size={16} weight="bold" />
                <Text style={s.blockTitle}>Per-unit work &amp; your pay</Text>
              </View>
              {unitLines.map((l, i) => {
                const rate = Number(l.unitCost) || 0; // pay per unit
                const qty = Number(l.qty) || 0;
                const pay = Number(l.cost) || 0;
                return (
                  <View key={l.itemId || i} style={s.unitRow}>
                    <View style={{ flex: 1, paddingRight: 10 }}>
                      <Text style={s.unitName}>{l.name || "Line item"}</Text>
                      <Text style={s.unitMeta}>
                        {qty} {l.unit || "unit"} @ {money(rate)}/{l.unit || "unit"}
                      </Text>
                    </View>
                    <Text style={s.unitPay}>{money(pay)}</Text>
                  </View>
                );
              })}
              <View style={s.unitTotalRow}>
                <Text style={s.unitTotalLabel}>Your pay (per-unit)</Text>
                <Text style={s.unitTotalVal}>{money(unitPayTotal)}</Text>
              </View>
            </View>
          )}

          {/* Checklist — tappable */}
          {checklist.length > 0 && (
            <View style={s.block}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                <Text style={s.blockTitle}>Checklist</Text>
                <Text style={s.checkProgress}>
                  {checklist.filter((i: any) => (typeof i === "object" ? i.done : false)).length}/{checklist.length}
                </Text>
              </View>
              {checklist.map((item: any, i: number) => {
                const done = typeof item === "object" ? item.done : false;
                const required = typeof item === "object" && item.required === true;
                const label = typeof item === "object" ? item.label || item.text : String(item);
                return (
                  <Pressable
                    key={i}
                    style={s.checkRow}
                    onPress={() => toggleChecklist.mutate({ index: i, done: !done })}
                    hitSlop={8}
                  >
                    {done
                      ? <CheckSquare color={C.green} size={22} weight="fill" />
                      : <Square color={required ? C.brand : C.muted} size={22} />}
                    <Text style={[s.checkTxt, done && { color: C.muted, textDecorationLine: "line-through" }]}>{label}</Text>
                    {required && !done && (
                      <View style={s.requiredPill}>
                        <Text style={s.requiredPillTxt}>Required</Text>
                      </View>
                    )}
                  </Pressable>
                );
              })}
            </View>
          )}

          {/* Photos */}
          <View style={s.block}>
            <View style={s.photoHead}>
              <Text style={s.blockTitle}>Photos</Text>
              <Pressable onPress={capturePhoto} style={s.photoBtn} disabled={uploading} accessibilityRole="button" accessibilityLabel="Take photo">
                {uploading ? <ActivityIndicator color={C.brand} size="small" /> : <Camera color={C.brand} size={18} weight="fill" />}
                <Text style={s.photoBtnTxt}>{uploading ? "Uploading…" : "Add photo"}</Text>
              </Pressable>
            </View>
            {(photos.data?.length ?? 0) > 0 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 10 }}>
                <View style={{ flexDirection: "row", gap: 10 }}>
                  {photos.data!.map((p) => (
                    <Image key={p.id} source={{ uri: assetUrl(p.url) }} style={s.thumb} />
                  ))}
                </View>
              </ScrollView>
            ) : (
              <Text style={s.emptyPhoto}>No photos yet. Capture before/after shots.</Text>
            )}
          </View>

          {/* ─── Driver Field Notes → Office ─────────────────────────── */}
          <View style={[s.block, s.driverNoteBlock]}>
            <Pressable
              style={s.collapsibleHeader}
              onPress={() => setDriverNoteExpanded(v => !v)}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <PencilSimple color="#f59e0b" size={16} weight="fill" />
                <Text style={[s.blockTitle, { color: "#f59e0b" }]}>Field Notes to Office</Text>
                {!!j.driverNotes && (
                  <View style={[s.unreadBadge, { backgroundColor: "#f59e0b22", borderColor: "#f59e0b" }]}>
                    <Text style={[s.unreadTxt, { color: "#f59e0b" }]}>saved</Text>
                  </View>
                )}
              </View>
              {driverNoteExpanded
                ? <CaretUp color={C.muted} size={14} />
                : <CaretDown color={C.muted} size={14} />}
            </Pressable>
            {!driverNoteExpanded && !!j.driverNotes && (
              <Text style={s.collapsedPreview} numberOfLines={2}>{j.driverNotes}</Text>
            )}
            {driverNoteExpanded && (
              <View style={{ marginTop: 10, gap: 10 }}>
                <Text style={s.sectionHint}>
                  These notes are saved to the job record and visible to dispatch and management.
                </Text>
                <TextInput
                  value={driverNote}
                  onChangeText={setDriverNote}
                  placeholder="E.g. 'Access code is 4521. Client requested call before arrival next time.'"
                  placeholderTextColor={C.muted}
                  style={[s.msgInput, { minHeight: 90, paddingTop: 10 }]}
                  multiline
                  textAlignVertical="top"
                />
                <Pressable
                  onPress={saveDriverNote}
                  disabled={savingNote || !driverNote.trim()}
                  style={[s.saveNoteBtn, (!driverNote.trim() || savingNote) && { opacity: 0.5 }]}
                >
                  {savingNote
                    ? <ActivityIndicator color="#04121c" size="small" />
                    : <Text style={s.saveNoteBtnTxt}>Save Note to Office</Text>}
                </Pressable>
              </View>
            )}
          </View>

          {/* ─── Dispatch Direct Thread ───────────────────────────────── */}
          <View style={[s.block, s.dispatchBlock]}>
            <Pressable
              style={s.collapsibleHeader}
              onPress={() => setDispatchExpanded(v => !v)}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Headset color={C.cyan} size={16} weight="fill" />
                <Text style={[s.blockTitle, { color: C.cyan }]}>Dispatch</Text>
                {(directThread.data?.direct ?? []).filter(
                  (m: any) => m.senderRole === "dispatch" && !m.read,
                ).length > 0 && (
                  <View style={s.unreadBadge}>
                    <Text style={s.unreadTxt}>
                      {(directThread.data?.direct ?? []).filter(
                        (m: any) => m.senderRole === "dispatch" && !m.read,
                      ).length} new
                    </Text>
                  </View>
                )}
              </View>
              {dispatchExpanded
                ? <CaretUp color={C.muted} size={14} />
                : <CaretDown color={C.muted} size={14} />}
            </Pressable>
            {/* Collapsed preview: show last message */}
            {!dispatchExpanded && (directThread.data?.direct ?? []).length > 0 && (
              <Text style={s.collapsedPreview} numberOfLines={1}>
                {(directThread.data?.direct as any[])?.at(-1)?.body ?? ""}
              </Text>
            )}
            {!dispatchExpanded && (directThread.data?.direct ?? []).length === 0 && (
              <Text style={[s.collapsedPreview, { fontStyle: "italic" }]}>Tap to message dispatch</Text>
            )}
            {dispatchExpanded && (
              <>
                <View style={{ gap: 8, marginTop: 8 }}>
                  {(directThread.data?.direct ?? []).length === 0 ? (
                    <Text style={s.emptyPhoto}>No messages from dispatch yet.</Text>
                  ) : (
                    (directThread.data?.direct ?? []).map((m: any) => {
                      const mine = m.senderRole === "tech";
                      return (
                        <View key={m.id} style={[s.bubble, mine ? s.bubbleMine : s.bubbleDispatch]}>
                          {!mine && (
                            <Text style={[s.bubbleName, { color: C.cyan }]}>
                              {m.senderName || "Dispatch"}
                            </Text>
                          )}
                          <Text style={[s.bubbleTxt, mine && { color: "#04121c" }]}>{m.body}</Text>
                          <Text style={s.bubbleTime}>
                            {new Date(m.createdAt).toLocaleTimeString([], {
                              hour: "numeric",
                              minute: "2-digit",
                            })}
                          </Text>
                        </View>
                      );
                    })
                  )}
                </View>
                <View style={s.msgInputRow}>
                  <TextInput
                    value={dispatchMsg}
                    onChangeText={setDispatchMsg}
                    placeholder="Message dispatch…"
                    placeholderTextColor={C.muted}
                    style={s.msgInput}
                    multiline
                  />
                  <Pressable
                    onPress={() => dispatchMsg.trim() && sendDispatch.mutate(dispatchMsg.trim())}
                    style={[s.sendBtn, { backgroundColor: C.cyan }, !dispatchMsg.trim() && { opacity: 0.5 }]}
                    disabled={!dispatchMsg.trim() || sendDispatch.isPending}
                  >
                    {sendDispatch.isPending ? (
                      <ActivityIndicator color="#04121c" size="small" />
                    ) : (
                      <PaperPlaneRight color="#04121c" size={18} weight="fill" />
                    )}
                  </Pressable>
                </View>
              </>
            )}
          </View>

          {/* ─── Customer Messages ────────────────────────────────────── */}
          <View style={s.block}>
            <Pressable
              style={s.collapsibleHeader}
              onPress={() => setCustomerExpanded(v => !v)}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Buildings color={C.sub} size={16} weight="fill" />
                <Text style={s.blockTitle}>{customerNoun} Messages</Text>
                {(messages.data ?? []).length > 0 && (
                  <Text style={s.threadCount}>{(messages.data ?? []).length}</Text>
                )}
              </View>
              {customerExpanded
                ? <CaretUp color={C.muted} size={14} />
                : <CaretDown color={C.muted} size={14} />}
            </Pressable>
            {!customerExpanded && (messages.data ?? []).length > 0 && (
              <Text style={s.collapsedPreview} numberOfLines={1}>
                {(messages.data as any[]).at(-1)?.body ?? ""}
              </Text>
            )}
            {!customerExpanded && (messages.data ?? []).length === 0 && (
              <Text style={[s.collapsedPreview, { fontStyle: "italic" }]}>Tap to message client</Text>
            )}
            {customerExpanded && (
              <>
                <View style={{ gap: 8, marginTop: 8 }}>
                  {(messages.data ?? []).length === 0 ? (
                    <Text style={s.emptyPhoto}>No messages yet.</Text>
                  ) : (
                    (messages.data ?? []).map((m) => {
                      const mine = m.senderRole === "tech";
                      return (
                        <View key={m.id} style={[s.bubble, mine ? s.bubbleMine : s.bubbleThem]}>
                          {!mine && <Text style={s.bubbleName}>{m.senderName || m.senderRole}</Text>}
                          <Text style={[s.bubbleTxt, mine && { color: "#04121c" }]}>{m.body}</Text>
                        </View>
                      );
                    })
                  )}
                </View>
                <View style={s.msgInputRow}>
                  <TextInput
                    value={msg}
                    onChangeText={setMsg}
                    placeholder="Message customer…"
                    placeholderTextColor={C.muted}
                    style={s.msgInput}
                    multiline
                  />
                  <Pressable
                    onPress={() => msg.trim() && sendMsg.mutate(msg.trim())}
                    style={[s.sendBtn, !msg.trim() && { opacity: 0.5 }]}
                    disabled={!msg.trim() || sendMsg.isPending}
                  >
                    {sendMsg.isPending ? <ActivityIndicator color="#04121c" size="small" /> : <PaperPlaneRight color="#04121c" size={18} weight="fill" />}
                  </Pressable>
                </View>
              </>
            )}
          </View>

          <View style={{ height: 90 }} />
        </ScrollView>

        {/* Sticky action */}
        {action && (
          <View style={s.footer}>
            {setStatus.isPaused && (
              <Text style={s.offlineHint}>No signal — will send the moment you're back online</Text>
            )}
            <Button
              title={action.label}
              variant={action.variant}
              loading={setStatus.isPending}
              onPress={() => {
                if (action.next === "completed") {
                  // Hard gate on required checklist items — these represent a
                  // real compliance/quality-verification step the industry
                  // treats as mandatory before a job can be closed (e.g. a
                  // documented reading, a required sign-off, a final QI-style
                  // check). Unlike routine steps, these actually BLOCK
                  // completion instead of just showing a dismissible warning
                  // — a soft nag doesn't reliably change behavior, a real
                  // gate does.
                  const uncheckedRequired = checklist.filter(
                    (i: any) => typeof i === "object" && i.required === true && !i.done,
                  );
                  if (uncheckedRequired.length > 0) {
                    Alert.alert(
                      "Required steps not done",
                      `Complete the following before finishing this job:\n\n${uncheckedRequired
                        .map((i: any) => `• ${i.label}`)
                        .join("\n")}`,
                      [{ text: "Go back", style: "cancel" }],
                    );
                    return;
                  }

                  // Show debrief summary before completing
                  const unchecked = checklist.filter((i: any) => !(typeof i === "object" ? i.done : false)).length;
                  const photoCount = photos.data?.length ?? 0;
                  const onSiteMin = j.onSiteMinutes ?? 0;
                  const timeStr = onSiteMin >= 60
                    ? `${Math.floor(onSiteMin / 60)}h ${onSiteMin % 60}m`
                    : onSiteMin > 0 ? `${onSiteMin} min` : null;
                  const transitStr = fmtMinutes(j.transitMinutes);
                  const mileageStr = typeof j.mileageKm === "number" ? `${j.mileageKm.toFixed(1)} km` : null;

                  const lines: string[] = [];
                  if (transitStr !== "—") lines.push(`🚗 Time in transit: ${transitStr}`);
                  if (timeStr) lines.push(`⏱ Time on site: ${timeStr}`);
                  if (mileageStr) lines.push(`📍 Total mileage: ${mileageStr}`);
                  lines.push(`📸 Photos: ${photoCount}`);
                  if (unchecked > 0) lines.push(`⚠️ ${unchecked} checklist item${unchecked > 1 ? "s" : ""} not done`);
                  lines.push(`💰 Earning: ${money(j.price)}`);

                  Alert.alert(
                    "Complete job?",
                    lines.join("\n"),
                    [
                      { text: "Go back", style: "cancel" },
                      {
                        text: "Confirm complete",
                        style: "default",
                        onPress: () => setStatus.mutate("completed"),
                      },
                    ]
                  );
                } else {
                  setStatus.mutate(action.next);
                }
              }}
            />
            {action.hint ? (
              <Text style={s.footerHint}>{action.hint}</Text>
            ) : null}
          </View>
        )}
        {j.status === "completed" && (
          <View style={s.footer}>
            <View style={s.doneBanner}>
              <CheckSquare color={C.green} size={20} weight="fill" />
              <Text style={s.doneTxt}>{jobNoun} completed · {money(j.price)} earned</Text>
            </View>
          </View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  offlineHint: { color: C.amber, fontSize: 11, fontWeight: "700", textAlign: "center", marginBottom: 8 },
  safe: { flex: 1, backgroundColor: C.bg },
  topbar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  backBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  topTitle: { flex: 1, color: C.text, fontSize: 17, fontWeight: "800", textAlign: "center" },
  scroll: { padding: 16, gap: 14 },
  statusRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  price: { color: C.green, fontSize: 20, fontWeight: "900" },
  block: {
    backgroundColor: C.card,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: C.border,
    padding: 16,
  },
  blockTitle: { color: C.sub, fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 1 },
  custRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  custIcon: { width: 42, height: 42, borderRadius: 21, backgroundColor: C.bg3, alignItems: "center", justifyContent: "center" },
  custName: { color: C.text, fontSize: 16, fontWeight: "700" },
  custMeta: { color: C.sub, fontSize: 13, marginTop: 2 },
  contactBtns: { flexDirection: "row", gap: 8 },
  iconBtn: { width: 42, height: 42, borderRadius: 21, backgroundColor: "rgba(14,165,233,0.14)", alignItems: "center", justifyContent: "center" },
  etaCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 12,
    backgroundColor: "rgba(34,211,238,0.08)",
    borderWidth: 1,
    borderColor: "rgba(34,211,238,0.25)",
    borderRadius: 14,
    padding: 12,
  },
  etaMain: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  etaBig: { color: C.text, fontSize: 17, fontWeight: "800" },
  etaSub: { color: C.sub, fontSize: 12, marginTop: 2 },
  etaTextBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: C.cyan,
    borderRadius: 11,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  etaTextBtnTxt: { color: "#04121c", fontSize: 13, fontWeight: "800" },
  addrRow: { flexDirection: "row", alignItems: "flex-start", gap: 9 },
  addr: { color: C.text, fontSize: 15, flex: 1, lineHeight: 21 },
  liveRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 12 },
  liveDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: C.green },
  liveTxt: { color: C.green, fontSize: 12, fontWeight: "600", flex: 1 },
  geoHint: { color: C.sub, fontSize: 12, marginTop: 10, lineHeight: 17 },
  clockCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 12,
    padding: 14,
    borderRadius: 14,
    backgroundColor: "rgba(34,197,94,0.10)",
    borderWidth: 1,
    borderColor: "rgba(34,197,94,0.35)",
  },
  clockCardPaused: {
    backgroundColor: "rgba(148,163,184,0.12)",
    borderColor: "rgba(148,163,184,0.35)",
  },
  clockBig: { color: C.text, fontSize: 15, fontWeight: "800" },
  clockSub: { color: C.sub, fontSize: 12, marginTop: 2, lineHeight: 16 },
  statsRow: { flexDirection: "row", gap: 8, marginTop: 12 },
  statCard: {
    flex: 1,
    alignItems: "center",
    gap: 4,
    paddingVertical: 12,
    paddingHorizontal: 6,
    borderRadius: 12,
    backgroundColor: "rgba(148,163,184,0.08)",
    borderWidth: 1,
    borderColor: C.border,
  },
  statVal: { color: C.text, fontSize: 14, fontWeight: "800" },
  statLbl: { color: C.muted, fontSize: 10.5, fontWeight: "600", textAlign: "center" },
  eta: { color: C.cyan, fontSize: 12, fontWeight: "800" },
  notes: { color: C.text, fontSize: 14, lineHeight: 21, marginTop: 8 },
  fieldRow: { flexDirection: "row", justifyContent: "space-between", gap: 12, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.border },
  fieldKey: { color: C.muted, fontSize: 13, textTransform: "capitalize" },
  fieldVal: { color: C.text, fontSize: 14, fontWeight: "600", flexShrink: 1, textAlign: "right" },
  unitHead: { flexDirection: "row", alignItems: "center", gap: 7, marginBottom: 4 },
  unitRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.border },
  unitName: { color: C.text, fontSize: 14, fontWeight: "700" },
  unitMeta: { color: C.muted, fontSize: 12.5, marginTop: 2 },
  unitPay: { color: C.green, fontSize: 15, fontWeight: "800" },
  unitTotalRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: 10, marginTop: 2 },
  unitTotalLabel: { color: C.sub, fontSize: 13, fontWeight: "700" },
  unitTotalVal: { color: C.green, fontSize: 17, fontWeight: "900" },
  checkRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.border + "44" },
  checkTxt: { color: C.text, fontSize: 14, flex: 1 },
  requiredPill: { backgroundColor: C.brand + "22", borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, flexShrink: 0 },
  requiredPillTxt: { color: C.brand, fontSize: 10, fontWeight: "700", textTransform: "uppercase" },
  checkProgress: { color: C.muted, fontSize: 12, fontWeight: "700" },
  photoHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  photoBtn: { flexDirection: "row", alignItems: "center", gap: 6 },
  photoBtnTxt: { color: C.brand, fontSize: 13, fontWeight: "700" },
  thumb: { width: 96, height: 96, borderRadius: 12, backgroundColor: C.bg3 },
  emptyPhoto: { color: C.muted, fontSize: 13, marginTop: 8 },
  bubble: { maxWidth: "82%", borderRadius: 14, paddingHorizontal: 13, paddingVertical: 9 },
  bubbleMine: { backgroundColor: C.brand, alignSelf: "flex-end" },
  bubbleThem: { backgroundColor: C.bg3, alignSelf: "flex-start" },
  bubbleDispatch: { backgroundColor: "rgba(34,211,238,0.12)", borderWidth: 1, borderColor: "rgba(34,211,238,0.25)", alignSelf: "flex-start" },
  bubbleName: { color: C.sub, fontSize: 11, fontWeight: "700", marginBottom: 2 },
  bubbleTxt: { color: C.text, fontSize: 14, lineHeight: 19 },
  bubbleTime: { color: C.muted, fontSize: 10, marginTop: 3, opacity: 0.7 },
  dispatchBlock: { borderColor: "rgba(34,211,238,0.25)", backgroundColor: "rgba(34,211,238,0.04)" },
  driverNoteBlock: { borderColor: "rgba(245,158,11,0.35)", backgroundColor: "rgba(245,158,11,0.04)" },
  dispatchHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  unreadBadge: { backgroundColor: C.cyan, borderRadius: 10, minWidth: 20, height: 20, alignItems: "center", justifyContent: "center", paddingHorizontal: 5, marginLeft: 4 },
  unreadTxt: { color: "#04121c", fontSize: 11, fontWeight: "800" },
  collapsibleHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  collapsedPreview: { color: C.muted, fontSize: 12, marginTop: 6, lineHeight: 17 },
  sectionHint: { color: C.muted, fontSize: 12, lineHeight: 17 },
  saveNoteBtn: { backgroundColor: "#f59e0b", borderRadius: 12, paddingVertical: 11, paddingHorizontal: 20, alignItems: "center" },
  saveNoteBtnTxt: { color: "#04121c", fontWeight: "700", fontSize: 14 },
  threadCount: { backgroundColor: C.bg3, borderRadius: 10, minWidth: 20, height: 18, alignItems: "center", justifyContent: "center", paddingHorizontal: 6, color: C.muted, fontSize: 11, fontWeight: "700", textAlign: "center" },
  msgInputRow: { flexDirection: "row", alignItems: "flex-end", gap: 8, marginTop: 12 },
  msgInput: {
    flex: 1,
    backgroundColor: C.bg3,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 13,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: C.text,
    fontSize: 14,
    maxHeight: 100,
  },
  sendBtn: { width: 44, height: 44, borderRadius: 13, backgroundColor: C.brand, alignItems: "center", justifyContent: "center" },
  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    padding: 16,
    paddingBottom: 28,
    backgroundColor: C.bg2,
    borderTopWidth: 1,
    borderTopColor: C.border,
  },
  doneBanner: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  doneTxt: { color: C.green, fontSize: 14, fontWeight: "700" },
  footerHint: { color: C.muted, fontSize: 12, textAlign: "center", marginTop: 8 },

  // Staff notes (amber highlight block)
  staffNotesBlock: {
    borderColor: "rgba(245,158,11,0.4)",
    backgroundColor: "rgba(245,158,11,0.07)",
  },
  staffNotesText: {
    color: "#fbbf24",
    fontSize: 14,
    lineHeight: 21,
  },

  // Job progress stepper
  stepperCard: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 36,
    backgroundColor: C.card,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: C.border,
  },
  stepDot: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: C.bg3,
    borderWidth: 2,
    borderColor: C.border,
    alignItems: "center",
    justifyContent: "center",
  },
  stepDotActive: {
    borderColor: C.brand,
    backgroundColor: "rgba(14,165,233,0.15)",
  },
  stepDotDone: {
    borderColor: C.green,
    backgroundColor: "rgba(34,197,94,0.12)",
  },
  stepLine: {
    flex: 1,
    height: 2,
    backgroundColor: C.border,
    marginHorizontal: 2,
  },
  stepLineDone: {
    backgroundColor: C.green,
  },
  stepLabel: {
    color: C.muted,
    fontSize: 10,
    fontWeight: "600",
    textAlign: "center",
  },
});
