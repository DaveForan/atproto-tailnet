CREATE INDEX "audit_logs_tenant_created_idx" ON "audit_logs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "board_posts_tenant_idx" ON "board_posts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "device_approvals_tenant_idx" ON "device_approvals" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "invitations_tenant_idx" ON "invitations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "invitations_invitee_did_idx" ON "invitations" USING btree ("invitee_did");--> statement-breakpoint
CREATE INDEX "join_requests_tenant_idx" ON "join_requests" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "service_devices_tenant_idx" ON "service_devices" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "services_tenant_idx" ON "services" USING btree ("tenant_id");