CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"hashed_key" text NOT NULL,
	"prefix" text DEFAULT '' NOT NULL,
	"scopes" text DEFAULT '' NOT NULL,
	"key_type" text DEFAULT 'secret' NOT NULL,
	"public_key" text DEFAULT '' NOT NULL,
	"allowed_origins" text DEFAULT '' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"filename" text NOT NULL,
	"url" text NOT NULL,
	"storage_key" text DEFAULT '' NOT NULL,
	"mime" text DEFAULT '' NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"uploaded_by" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"actor_id" text DEFAULT '' NOT NULL,
	"actor_name" text DEFAULT '' NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text DEFAULT '' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"meta" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"trigger" text NOT NULL,
	"conditions" text DEFAULT '{}' NOT NULL,
	"action" text NOT NULL,
	"action_config" text DEFAULT '{}' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"runs_count" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "booking_change_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"booking_id" text NOT NULL,
	"requested_by" text DEFAULT '' NOT NULL,
	"requested_by_name" text DEFAULT '' NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"proposed_at" timestamp with time zone,
	"previous_at" timestamp with time zone,
	"decided_by" text DEFAULT '' NOT NULL,
	"decided_by_name" text DEFAULT '' NOT NULL,
	"decided_at" timestamp with time zone,
	"decision_note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "booking_option_selections" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"booking_id" text NOT NULL,
	"category_id" text NOT NULL,
	"category_name" text DEFAULT '' NOT NULL,
	"item_id" text NOT NULL,
	"item_name" text DEFAULT '' NOT NULL,
	"tier_label" text DEFAULT '' NOT NULL,
	"price_delta" numeric(12, 2) DEFAULT 0 NOT NULL,
	"selected_by" text DEFAULT 'customer' NOT NULL,
	"signature_name" text DEFAULT '' NOT NULL,
	"selected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"customer_id" text NOT NULL,
	"service_id" text NOT NULL,
	"rider_id" text,
	"template_id" text,
	"title" text DEFAULT '' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"address" text NOT NULL,
	"property_id" text,
	"lat" double precision DEFAULT 43.6532 NOT NULL,
	"lng" double precision DEFAULT -79.3832 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"staff_notes" text DEFAULT '' NOT NULL,
	"driver_notes" text DEFAULT '' NOT NULL,
	"signature_url" text DEFAULT '' NOT NULL,
	"signature_name" text DEFAULT '' NOT NULL,
	"signed_at" timestamp with time zone,
	"field_data" text DEFAULT '{}' NOT NULL,
	"checklist_state" text DEFAULT '[]' NOT NULL,
	"price" numeric(12, 2) DEFAULT 0 NOT NULL,
	"rate_model" text DEFAULT '' NOT NULL,
	"line_items" text DEFAULT '[]' NOT NULL,
	"line_items_cost" numeric(12, 2) DEFAULT 0 NOT NULL,
	"line_items_price" numeric(12, 2) DEFAULT 0 NOT NULL,
	"region" text DEFAULT '' NOT NULL,
	"subtotal" numeric(12, 2) DEFAULT 0 NOT NULL,
	"tax_amount" numeric(12, 2) DEFAULT 0 NOT NULL,
	"tax_rate_pct" double precision DEFAULT 0 NOT NULL,
	"tax_label" text DEFAULT '' NOT NULL,
	"total" numeric(12, 2) DEFAULT 0 NOT NULL,
	"price_breakdown" text DEFAULT '' NOT NULL,
	"enroute_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"on_site_minutes" double precision DEFAULT 0 NOT NULL,
	"transit_minutes" double precision DEFAULT 0 NOT NULL,
	"clock_state" text DEFAULT 'idle' NOT NULL,
	"accumulated_ms" integer DEFAULT 0 NOT NULL,
	"last_resume_at" timestamp with time zone,
	"inside_geofence" boolean DEFAULT false NOT NULL,
	"mileage_km" double precision DEFAULT 0 NOT NULL,
	"tech_pay" numeric(12, 2) DEFAULT 0 NOT NULL,
	"tech_pay_breakdown" text DEFAULT '' NOT NULL,
	"payment_status" text DEFAULT 'unpaid' NOT NULL,
	"payout_id" text DEFAULT '' NOT NULL,
	"public_token" text NOT NULL,
	"customer_phone" text DEFAULT '' NOT NULL,
	"sms_sent_at" timestamp with time zone,
	"token_expires_at" timestamp with time zone,
	"eta_mins" integer,
	"eta_distance_km" double precision,
	"delay_flagged_at" timestamp with time zone,
	"delay_flagged_mins" integer,
	"delay_notified_at" timestamp with time zone,
	"delay_notified_mins" integer,
	"delay_muted" boolean DEFAULT false NOT NULL,
	"assign_status" text DEFAULT 'none' NOT NULL,
	"assigned_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"decline_reason" text DEFAULT '' NOT NULL,
	"required_skill_class" text DEFAULT '' NOT NULL,
	"required_skills" text DEFAULT '' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_items" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"kind" text DEFAULT 'product' NOT NULL,
	"name" text NOT NULL,
	"sku" text DEFAULT '' NOT NULL,
	"category" text DEFAULT 'General' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"image" text DEFAULT '' NOT NULL,
	"unit" text DEFAULT 'each' NOT NULL,
	"unit_cost" numeric(12, 2) DEFAULT 0 NOT NULL,
	"markup_pct" double precision DEFAULT 0 NOT NULL,
	"price_mode" text DEFAULT 'auto' NOT NULL,
	"unit_price" numeric(12, 2) DEFAULT 0 NOT NULL,
	"taxable" boolean DEFAULT true NOT NULL,
	"components" text DEFAULT '[]' NOT NULL,
	"service_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"contact_email" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"plan" text DEFAULT 'starter' NOT NULL,
	"industry" text DEFAULT '' NOT NULL,
	"industry_other" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_settings" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"name" text DEFAULT 'NVC 360' NOT NULL,
	"legal_name" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"address" text DEFAULT '423 Main Street, Winnipeg, Manitoba, Canada' NOT NULL,
	"lat" double precision DEFAULT 49.8951 NOT NULL,
	"lng" double precision DEFAULT -97.1384 NOT NULL,
	"timezone" text DEFAULT 'America/Winnipeg' NOT NULL,
	"currency" text DEFAULT 'CAD' NOT NULL,
	"tax_rate" double precision DEFAULT 5 NOT NULL,
	"tax_label" text DEFAULT 'GST' NOT NULL,
	"default_region" text DEFAULT 'MB' NOT NULL,
	"auto_tax_by_region" boolean DEFAULT true NOT NULL,
	"logo" text DEFAULT '' NOT NULL,
	"logo_source_url" text DEFAULT '' NOT NULL,
	"brand_color" text DEFAULT '#06B6D4' NOT NULL,
	"accent_color" text DEFAULT '' NOT NULL,
	"worker_noun" text DEFAULT 'Technician' NOT NULL,
	"worker_noun_plural" text DEFAULT 'Technicians' NOT NULL,
	"customer_noun" text DEFAULT 'Customer' NOT NULL,
	"customer_noun_plural" text DEFAULT 'Customers' NOT NULL,
	"job_noun" text DEFAULT 'Job' NOT NULL,
	"job_noun_plural" text DEFAULT 'Jobs' NOT NULL,
	"tagline" text DEFAULT '' NOT NULL,
	"hours" text DEFAULT '' NOT NULL,
	"services" text DEFAULT '' NOT NULL,
	"socials" text DEFAULT '' NOT NULL,
	"geofence_radius_m" integer DEFAULT 150 NOT NULL,
	"review_request_enabled" boolean DEFAULT true NOT NULL,
	"review_request_delay_mins" integer DEFAULT 120 NOT NULL,
	"google_review_url" text DEFAULT '' NOT NULL,
	"website" text DEFAULT '' NOT NULL,
	"allow_customer_reschedule" boolean DEFAULT true NOT NULL,
	"allow_customer_cancel_request" boolean DEFAULT true NOT NULL,
	"customer_change_cutoff_hours" integer DEFAULT 12 NOT NULL,
	"delay_notice_enabled" boolean DEFAULT true NOT NULL,
	"delay_notice_threshold_mins" integer DEFAULT 15 NOT NULL,
	"delay_notice_auto_send_after_mins" integer DEFAULT 10 NOT NULL,
	"updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_field_values" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"field_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"value" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_fields" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"entity" text NOT NULL,
	"label" text NOT NULL,
	"type" text DEFAULT 'text' NOT NULL,
	"options" text DEFAULT '[]' NOT NULL,
	"placeholder" text DEFAULT '' NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"section" text DEFAULT 'General' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"name" text DEFAULT 'Untitled template' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"design" text DEFAULT '[]' NOT NULL,
	"is_builtin" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_tags" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"tag_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "icp_knowledge_base" (
	"industry" text PRIMARY KEY NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"best_practices" text DEFAULT '' NOT NULL,
	"workflow_notes" text DEFAULT '' NOT NULL,
	"terminology_notes" text DEFAULT '' NOT NULL,
	"tone_refinement" text DEFAULT '' NOT NULL,
	"notification_refinement" text DEFAULT '' NOT NULL,
	"compliance_notes" text DEFAULT '' NOT NULL,
	"sources" text DEFAULT '' NOT NULL,
	"researched_by" text DEFAULT '' NOT NULL,
	"researched_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"scope" text DEFAULT 'payment' NOT NULL,
	"response_status" integer,
	"response_body" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake_forms" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"slug" text NOT NULL,
	"title" text DEFAULT 'Request Service' NOT NULL,
	"intro" text DEFAULT '' NOT NULL,
	"fields" text DEFAULT '[]' NOT NULL,
	"sections" text DEFAULT '[]' NOT NULL,
	"recipient_name" text DEFAULT '' NOT NULL,
	"recipient_email" text DEFAULT '' NOT NULL,
	"public_key_id" text DEFAULT '' NOT NULL,
	"brand_color" text DEFAULT '#06b6d4' NOT NULL,
	"logo_url" text DEFAULT '' NOT NULL,
	"success_message" text DEFAULT 'Thanks! We''ve received your request and will reach out shortly.' NOT NULL,
	"default_service_id" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"submit_count" integer DEFAULT 0 NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"form_type" text DEFAULT 'lead' NOT NULL,
	"access_code" text DEFAULT '' NOT NULL,
	"allow_tech_assign" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"form_id" text DEFAULT '' NOT NULL,
	"booking_id" text DEFAULT '' NOT NULL,
	"payload" text DEFAULT '{}' NOT NULL,
	"ip_hash" text DEFAULT '' NOT NULL,
	"origin" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"account_label" text DEFAULT '' NOT NULL,
	"config" text DEFAULT '{}' NOT NULL,
	"access_token" text DEFAULT '' NOT NULL,
	"refresh_token" text DEFAULT '' NOT NULL,
	"expires_at" timestamp with time zone,
	"scope" text DEFAULT '' NOT NULL,
	"external_account_id" text DEFAULT '' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"booking_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"number" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"tax" numeric(12, 2) DEFAULT 0 NOT NULL,
	"total" numeric(12, 2) NOT NULL,
	"status" text DEFAULT 'unpaid' NOT NULL,
	"method" text DEFAULT 'card' NOT NULL,
	"paid_at" timestamp with time zone,
	"stripe_payment_intent_id" text,
	"stripe_charge_id" text,
	"amount_refunded" numeric(12, 2) DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'cad' NOT NULL,
	"last_payment_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_events" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"booking_id" text NOT NULL,
	"kind" text NOT NULL,
	"actor_role" text DEFAULT 'system' NOT NULL,
	"actor_name" text DEFAULT '' NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"meta" text DEFAULT '{}' NOT NULL,
	"customer_visible" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_photos" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"booking_id" text NOT NULL,
	"url" text NOT NULL,
	"caption" text DEFAULT '' NOT NULL,
	"source" text DEFAULT 'companycam' NOT NULL,
	"phase" text DEFAULT 'during' NOT NULL,
	"customer_visible" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"customer_id" text,
	"property_id" text,
	"service_id" text,
	"address" text DEFAULT '' NOT NULL,
	"interval_days" integer DEFAULT 180 NOT NULL,
	"remind_days_before" integer DEFAULT 7 NOT NULL,
	"next_due_at" timestamp with time zone,
	"last_service_at" timestamp with time zone,
	"notes" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"reminders_sent" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"company_id" text NOT NULL,
	"role" text DEFAULT 'customer' NOT NULL,
	"permissions" text,
	"staff_type" text,
	"manager_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"invited_by" text,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"booking_id" text,
	"rider_id" text,
	"sender_role" text NOT NULL,
	"sender_name" text DEFAULT '' NOT NULL,
	"body" text NOT NULL,
	"channel" text DEFAULT 'app' NOT NULL,
	"read" boolean DEFAULT false NOT NULL,
	"read_by_tech" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"in_app_enabled" boolean DEFAULT true NOT NULL,
	"email_enabled" boolean DEFAULT true NOT NULL,
	"sms_enabled" boolean DEFAULT true NOT NULL,
	"webhook_enabled" boolean DEFAULT true NOT NULL,
	"email_from_name" text DEFAULT 'NVC 360' NOT NULL,
	"email_from_address" text DEFAULT '' NOT NULL,
	"email_reply_to" text DEFAULT '' NOT NULL,
	"email_footer" text DEFAULT '' NOT NULL,
	"email_body_template" text DEFAULT '' NOT NULL,
	"sms_body_template" text DEFAULT '' NOT NULL,
	"sms_from_number" text DEFAULT '' NOT NULL,
	"sms_sender_id" text DEFAULT '' NOT NULL,
	"quiet_hours_enabled" boolean DEFAULT false NOT NULL,
	"quiet_start" text DEFAULT '21:00' NOT NULL,
	"quiet_end" text DEFAULT '08:00' NOT NULL,
	"quiet_channels" text DEFAULT 'sms,email' NOT NULL,
	"email_logo_url" text DEFAULT '' NOT NULL,
	"email_brand_color" text DEFAULT '#06B6D4' NOT NULL,
	"email_header_style" text DEFAULT 'gradient' NOT NULL,
	"email_bg_color" text DEFAULT '#f1f5f9' NOT NULL,
	"updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"event" text NOT NULL,
	"booking_id" text,
	"recipient" text NOT NULL,
	"channel" text NOT NULL,
	"target" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'sent' NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"event" text NOT NULL,
	"recipient" text NOT NULL,
	"in_app" boolean DEFAULT true NOT NULL,
	"email" boolean DEFAULT false NOT NULL,
	"sms" boolean DEFAULT false NOT NULL,
	"webhook" boolean DEFAULT false NOT NULL,
	"template" text DEFAULT '' NOT NULL,
	"email_subject" text DEFAULT '' NOT NULL,
	"email_design" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"user_id" text NOT NULL,
	"booking_id" text,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_app_credentials" (
	"provider" text PRIMARY KEY NOT NULL,
	"client_id" text DEFAULT '' NOT NULL,
	"client_secret" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "option_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "option_category_items" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"category_id" text NOT NULL,
	"tier_label" text DEFAULT '' NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"image" text DEFAULT '' NOT NULL,
	"price_delta" numeric(12, 2) DEFAULT 0 NOT NULL,
	"unit_cost" numeric(12, 2) DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"invoice_id" text,
	"booking_id" text,
	"kind" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"currency" text DEFAULT 'cad' NOT NULL,
	"stripe_object_id" text,
	"status" text NOT NULL,
	"memo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"rider_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"jobs_count" integer DEFAULT 0 NOT NULL,
	"gross" numeric(12, 2) DEFAULT 0 NOT NULL,
	"fee_pct" double precision DEFAULT 20 NOT NULL,
	"fee" numeric(12, 2) DEFAULT 0 NOT NULL,
	"net" numeric(12, 2) DEFAULT 0 NOT NULL,
	"hourly_pay" numeric(12, 2) DEFAULT 0 NOT NULL,
	"unit_pay" numeric(12, 2) DEFAULT 0 NOT NULL,
	"on_site_minutes" double precision DEFAULT 0 NOT NULL,
	"unrated_jobs" integer DEFAULT 0 NOT NULL,
	"breakdown" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"address_normalized" text NOT NULL,
	"address_display" text DEFAULT '' NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"customer_id" text,
	"public_token" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"platform" text DEFAULT 'ios' NOT NULL,
	"device_name" text DEFAULT '' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"booking_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"rider_id" text,
	"rating" integer NOT NULL,
	"comment" text DEFAULT '' NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"reply" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "riders" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"vehicle" text DEFAULT 'Van' NOT NULL,
	"skills" text DEFAULT '' NOT NULL,
	"skill_class" text DEFAULT 'General' NOT NULL,
	"color" text DEFAULT '#0ea5e9' NOT NULL,
	"photo_url" text DEFAULT '' NOT NULL,
	"photo_key" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"license_plate" text DEFAULT '' NOT NULL,
	"license_number" text DEFAULT '' NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'offline' NOT NULL,
	"manual_offline" boolean DEFAULT false NOT NULL,
	"pay_rate_per_hour" numeric(12, 2) DEFAULT 0 NOT NULL,
	"rating" double precision DEFAULT 4.9 NOT NULL,
	"completed_jobs" integer DEFAULT 0 NOT NULL,
	"approval" text DEFAULT 'active' NOT NULL,
	"invited_at" timestamp with time zone,
	"lat" double precision,
	"lng" double precision,
	"location_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role" text PRIMARY KEY NOT NULL,
	"perms" text DEFAULT '[]' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"kind" text NOT NULL,
	"booking_id" text,
	"property_id" text,
	"run_at" timestamp with time zone NOT NULL,
	"payload" text DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text DEFAULT '' NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_zones" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#06B6D4' NOT NULL,
	"polygon" text DEFAULT '[]' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"surge_multiplier" double precision DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"icon" text DEFAULT 'wrench' NOT NULL,
	"image" text DEFAULT '' NOT NULL,
	"base_price" numeric(12, 2) DEFAULT 0 NOT NULL,
	"duration_mins" integer DEFAULT 60 NOT NULL,
	"rate_model" text DEFAULT '' NOT NULL,
	"rating" double precision DEFAULT 4.8 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "skill_library" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"name" text NOT NULL,
	"category" text DEFAULT 'General' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"label" text NOT NULL,
	"color" text DEFAULT '#06B6D4' NOT NULL,
	"scope" text DEFAULT 'both' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"name" text NOT NULL,
	"category" text DEFAULT 'General' NOT NULL,
	"icon" text DEFAULT 'clipboard-list' NOT NULL,
	"color" text DEFAULT '#0ea5e9' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"fields" text DEFAULT '[]' NOT NULL,
	"checklist" text DEFAULT '[]' NOT NULL,
	"estimated_mins" integer DEFAULT 60 NOT NULL,
	"rate_model" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tech_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"email" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"skill_class" text DEFAULT 'General' NOT NULL,
	"token" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"invited_by" text DEFAULT '' NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tech_shifts" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"rider_id" text NOT NULL,
	"kind" text DEFAULT 'shift' NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"start_min" integer DEFAULT 540 NOT NULL,
	"end_min" integer DEFAULT 1020 NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_email_domains" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"domain" text NOT NULL,
	"resend_domain_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"region" text DEFAULT 'eu-west-1' NOT NULL,
	"records" text DEFAULT '[]' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"created_by" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracking_pings" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"booking_id" text NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"phase" text DEFAULT 'enroute' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"role" text DEFAULT 'customer',
	"phone" text,
	"company_id" text DEFAULT 'default' NOT NULL,
	"first_name" text,
	"last_name" text,
	"alt_phone" text,
	"company" text,
	"website" text,
	"customer_type" text,
	"address" text,
	"city" text,
	"region" text,
	"postal_code" text,
	"country" text,
	"notes" text,
	"addresses" text,
	"contacts" text,
	"calendar_token" text,
	"permissions" text,
	"staff_type" text,
	"manager_id" text,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text DEFAULT 'default' NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"url" text NOT NULL,
	"secret" text DEFAULT '' NOT NULL,
	"events" text DEFAULT '*' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_change_requests" ADD CONSTRAINT "booking_change_requests_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_option_selections" ADD CONSTRAINT "booking_option_selections_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_customer_id_user_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_rider_id_riders_id_fk" FOREIGN KEY ("rider_id") REFERENCES "public"."riders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_template_id_task_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."task_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_field_id_custom_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."custom_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_tags" ADD CONSTRAINT "entity_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_user_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_photos" ADD CONSTRAINT "job_photos_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_plans" ADD CONSTRAINT "maintenance_plans_customer_id_user_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_plans" ADD CONSTRAINT "maintenance_plans_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_plans" ADD CONSTRAINT "maintenance_plans_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_rider_id_riders_id_fk" FOREIGN KEY ("rider_id") REFERENCES "public"."riders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_category_items" ADD CONSTRAINT "option_category_items_category_id_option_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."option_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_ledger" ADD CONSTRAINT "payment_ledger_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_rider_id_riders_id_fk" FOREIGN KEY ("rider_id") REFERENCES "public"."riders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_customer_id_user_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_customer_id_user_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_rider_id_riders_id_fk" FOREIGN KEY ("rider_id") REFERENCES "public"."riders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "riders" ADD CONSTRAINT "riders_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tech_shifts" ADD CONSTRAINT "tech_shifts_rider_id_riders_id_fk" FOREIGN KEY ("rider_id") REFERENCES "public"."riders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracking_pings" ADD CONSTRAINT "tracking_pings_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "apikey_company_idx" ON "api_keys" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "attach_company_idx" ON "attachments" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_log" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_company_idx" ON "audit_log" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "autorule_company_idx" ON "automation_rules" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "chgreq_company_idx" ON "booking_change_requests" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "chgreq_booking_idx" ON "booking_change_requests" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "chgreq_status_idx" ON "booking_change_requests" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "optsel_booking_idx" ON "booking_option_selections" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "optsel_company_idx" ON "booking_option_selections" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "bk_company_idx" ON "bookings" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "bk_status_idx" ON "bookings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "bk_sched_idx" ON "bookings" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "bk_finished_idx" ON "bookings" USING btree ("finished_at");--> statement-breakpoint
CREATE INDEX "bk_rider_idx" ON "bookings" USING btree ("rider_id");--> statement-breakpoint
CREATE INDEX "bk_customer_idx" ON "bookings" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "bk_service_idx" ON "bookings" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "bk_paystatus_idx" ON "bookings" USING btree ("payment_status");--> statement-breakpoint
CREATE INDEX "bk_priority_idx" ON "bookings" USING btree ("priority");--> statement-breakpoint
CREATE INDEX "bk_region_idx" ON "bookings" USING btree ("region");--> statement-breakpoint
CREATE INDEX "bk_deleted_idx" ON "bookings" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "bk_created_idx" ON "bookings" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "catalog_company_idx" ON "catalog_items" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "settings_company_idx" ON "company_settings" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "cfv_company_idx" ON "custom_field_values" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "cf_company_idx" ON "custom_fields" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "emailtpl_company_idx" ON "email_templates" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "etags_company_idx" ON "entity_tags" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "form_categories_company_idx" ON "form_categories" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "intake_company_idx" ON "intake_forms" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "intake_slug_idx" ON "intake_forms" USING btree ("company_id","slug");--> statement-breakpoint
CREATE INDEX "intakesub_company_idx" ON "intake_submissions" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "intakesub_form_idx" ON "intake_submissions" USING btree ("form_id");--> statement-breakpoint
CREATE INDEX "integ_company_idx" ON "integrations" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "inv_company_idx" ON "invoices" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "inv_booking_idx" ON "invoices" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "inv_pi_idx" ON "invoices" USING btree ("stripe_payment_intent_id");--> statement-breakpoint
CREATE INDEX "jobev_company_idx" ON "job_events" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "jobev_booking_idx" ON "job_events" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "jobev_created_idx" ON "job_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "jobphoto_company_idx" ON "job_photos" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "jobphoto_phase_idx" ON "job_photos" USING btree ("booking_id","phase");--> statement-breakpoint
CREATE INDEX "mplan_company_idx" ON "maintenance_plans" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "mplan_due_idx" ON "maintenance_plans" USING btree ("active","next_due_at");--> statement-breakpoint
CREATE INDEX "mplan_prop_idx" ON "maintenance_plans" USING btree ("property_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_user_company_uidx" ON "memberships" USING btree ("user_id","company_id");--> statement-breakpoint
CREATE INDEX "memberships_company_idx" ON "memberships" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "msg_company_idx" ON "messages" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "msg_tech_unread_idx" ON "messages" USING btree ("booking_id","read_by_tech");--> statement-breakpoint
CREATE INDEX "notifchan_company_idx" ON "notification_channels" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "notifdeliv_company_idx" ON "notification_deliveries" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "notifrule_company_idx" ON "notification_rules" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "notif_company_idx" ON "notifications" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "optcat_company_idx" ON "option_categories" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "optitem_category_idx" ON "option_category_items" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "optitem_company_idx" ON "option_category_items" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "ledger_company_idx" ON "payment_ledger" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "ledger_invoice_idx" ON "payment_ledger" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "ledger_booking_idx" ON "payment_ledger" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "payout_company_idx" ON "payouts" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "prop_company_idx" ON "properties" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "prop_addr_idx" ON "properties" USING btree ("company_id","address_normalized");--> statement-breakpoint
CREATE INDEX "prop_token_idx" ON "properties" USING btree ("public_token");--> statement-breakpoint
CREATE INDEX "push_tokens_user_idx" ON "push_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "review_company_idx" ON "reviews" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "riders_company_idx" ON "riders" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "schedtask_company_idx" ON "scheduled_tasks" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "schedtask_due_idx" ON "scheduled_tasks" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX "schedtask_booking_idx" ON "scheduled_tasks" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "zone_company_idx" ON "service_zones" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "services_company_idx" ON "services" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "skill_company_idx" ON "skill_library" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "tags_company_idx" ON "tags" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "tasktpl_company_idx" ON "task_templates" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "techinvite_company_idx" ON "tech_invites" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "shift_company_idx" ON "tech_shifts" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "ted_company_idx" ON "tenant_email_domains" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "tp_booking_created_idx" ON "tracking_pings" USING btree ("booking_id","created_at");--> statement-breakpoint
CREATE INDEX "tp_created_idx" ON "tracking_pings" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "tp_company_idx" ON "tracking_pings" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "webhook_company_idx" ON "webhook_endpoints" USING btree ("company_id");