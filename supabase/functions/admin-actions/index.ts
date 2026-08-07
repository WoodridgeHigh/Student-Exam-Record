// Supabase Edge Function: admin-actions
// Handles account creation and password resets — the only operations
// needing the service role key, so they run here, never in the browser.
//
// Role hierarchy enforced here:
//   - teacher accounts: created by admin or super_admin
//   - admin accounts:   created only by super_admin
//   - super_admin:      never created through this app — one-time bootstrap
//                        in the Supabase dashboard, and the database itself
//                        only allows one to ever exist.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function usernameToEmail(username: string) {
  return `${username.toLowerCase().trim()}@examrecords.local`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ ok: false, error: "Not authenticated" }, 401);

    const { data: callerProfile } = await userClient.from("profiles").select("role").eq("id", user.id).single();
    if (!callerProfile || !["admin", "super_admin"].includes(callerProfile.role)) {
      return json({ ok: false, error: "Admin access required" }, 403);
    }

    const admin = createClient(supabaseUrl, serviceKey);
    const body = await req.json();

    if (body.action === "createTeacher") {
      const { username, password, name, role, grade, section } = body;
      if (!username || !password || !name || !role) {
        return json({ ok: false, error: "Missing required fields" });
      }
      if (password.length < 6) {
        return json({ ok: false, error: "Password must be at least 6 characters" });
      }
      if (role === "super_admin") {
        return json({ ok: false, error: "Super admin can't be created here — only one is allowed, set up during initial bootstrap." });
      }
      if (role === "admin" && callerProfile.role !== "super_admin") {
        return json({ ok: false, error: "Only the super admin can create admin accounts" }, 403);
      }
      if (!["teacher", "admin"].includes(role)) {
        return json({ ok: false, error: "Invalid role" });
      }

      const email = usernameToEmail(username);
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
      });
      if (createErr) return json({ ok: false, error: createErr.message });

      const { error: profileErr } = await admin.from("profiles").insert({
        id: created.user!.id,
        username: username.toLowerCase().trim(),
        name,
        role,
      });
      if (profileErr) {
        await admin.auth.admin.deleteUser(created.user!.id);
        return json({ ok: false, error: profileErr.message });
      }

      // Teacher assignments (subject+class access) — only relevant for role='teacher'.
      if (role === "teacher" && Array.isArray(body.assignments)) {
        for (const a of body.assignments) {
          await admin.from("teacher_assignments").insert({
            teacher_id: created.user!.id,
            subject_id: a.subjectId,
            grade: a.grade,
            section: a.section,
          });
        }
      }

      return json({ ok: true });
    }

    if (body.action === "resetPassword") {
      const { username, newPassword } = body;
      if (!username || !newPassword) return json({ ok: false, error: "Missing username or new password" });
      if (newPassword.length < 6) return json({ ok: false, error: "Password must be at least 6 characters" });

      const { data: prof } = await admin.from("profiles").select("id, role").eq("username", username.toLowerCase().trim()).single();
      if (!prof) return json({ ok: false, error: "No such username" });
      if (prof.role === "admin" && callerProfile.role !== "super_admin") {
        return json({ ok: false, error: "Only the super admin can reset an admin's password" }, 403);
      }

      const { error } = await admin.auth.admin.updateUserById(prof.id, { password: newPassword });
      if (error) return json({ ok: false, error: error.message });
      return json({ ok: true });
    }

    return json({ ok: false, error: "Unknown action" });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
});
