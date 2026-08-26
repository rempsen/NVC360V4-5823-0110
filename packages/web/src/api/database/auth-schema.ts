import { relations } from "drizzle-orm";
import { pgTable, text, boolean, timestamp, index } from "drizzle-orm/pg-core";

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified")
    .default(false)
    .notNull(),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
  role: text("role").default("customer"),
  phone: text("phone"),
  // --- Multi-tenancy: every user belongs to exactly one company (tenant). ---
  companyId: text("company_id").notNull().default("default"),
  // --- CRM client record fields ---
  // `name` stays the single display name used everywhere (job cards, emails,
  // exports). firstName/lastName are the structured capture from the intake
  // form; `name` is kept in sync as "first last" so nothing downstream breaks
  // for the records that predate the split.
  firstName: text("first_name"),
  lastName: text("last_name"),
  altPhone: text("alt_phone"),
  company: text("company"),
  // Company website for the client's business ("https://acme.com").
  website: text("website"),
  // How this client is expected to buy: 'one_time' | 'repeat'. Drives nothing
  // enforcement-wise today — it is a segmentation field for follow-up and
  // reporting.
  customerType: text("customer_type"),
  address: text("address"),
  city: text("city"),
  region: text("region"),
  postalCode: text("postal_code"),
  country: text("country"),
  notes: text("notes"),
  // JSON-encoded arrays for richer CRM records
  addresses: text("addresses"), // [{ label, line, city, region, postalCode, notes }]
  contacts: text("contacts"), // [{ name, role, phone, email }]
  // Per-user secret token for personal iCal calendar subscription feed
  calendarToken: text("calendar_token"),
  // --- Internal employee fields ---
  // Per-person permission override (JSON array of permission keys). NULL = use role defaults.
  permissions: text("permissions"),
  // For field staff (role=rider): 'technician' | 'driver'
  staffType: text("staff_type"),
  // Optional: which manager this employee reports to (user.id)
  managerId: text("manager_id"),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));
