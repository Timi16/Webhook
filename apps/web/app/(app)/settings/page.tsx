"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { issueText } from "@/components/auth";
import { Icon, type IconName } from "@/components/icons";
import { useSession } from "@/components/session";
import { useTheme, type ThemeChoice } from "@/components/theme";
import { ErrorAlert, Field, PageHead } from "@/components/ui";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { dateTime } from "@/lib/format";
import type { ApiKey, Endpoint, Page, Watch } from "@/lib/types";

const THEMES: { value: ThemeChoice; label: string; icon: IconName }[] = [
  { value: "system", label: "Match system", icon: "monitor" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];

interface AuditRow {
  id: string;
  at: string;
  action: string;
  targetId: string | null;
  targetLabel: string | null;
  actor: "session" | "api_key";
  apiKeyId: string | null;
  ip: string | null;
}

/** Plain words for the audit log's action names. */
const ACTIONS: Record<string, string> = {
  "account.created": "Account created",
  "account.logged_in": "Logged in",
  "account.profile_updated": "Profile updated",
  "account.password_changed": "Password changed",
  "account.email_change_requested": "Email change requested",
  "account.email_changed": "Email changed",
  "api_key.created": "API key created",
  "api_key.updated": "API key updated",
  "api_key.rolled": "API key rolled",
  "api_key.revoked": "API key revoked",
  "api_key.deleted": "API key deleted",
  "endpoint.created": "Endpoint added",
  "endpoint.updated": "Endpoint updated",
  "endpoint.deleted": "Endpoint deleted",
  "endpoint.secret_rotated": "Signing secret rotated",
  "endpoint.enabled": "Endpoint re-enabled",
  "endpoint.replayed": "Failed webhooks replayed",
  "watch.created": "Watch created",
  "watch.updated": "Watch updated",
  "watch.paused": "Watch paused",
  "watch.resumed": "Watch resumed",
  "watch.deleted": "Watch deleted",
  "event.resent": "Webhook resent",
};
const AUDIT_PAGE = 15;

/** Who changed what in the account, newest first. */
function AuditLog() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const first = useApi<Page<AuditRow>>(`/v1/audit-log?limit=${AUDIT_PAGE}`);
  const more = useAction(async (from: string) => {
    const page = await api<Page<AuditRow>>(
      `/v1/audit-log?limit=${AUDIT_PAGE}&cursor=${encodeURIComponent(from)}`,
    );
    setRows([...rows, ...page.data]);
    setNext(page.nextCursor);
  });
  const all = [...(first.data?.data ?? []), ...rows];
  const cursor = rows.length > 0 ? next : (first.data?.nextCursor ?? null);

  return (
    <section className="wh-panel wh-resp" id="audit-log">
      <header>
        <span className="h">Audit log</span>
        <span className="wh-reason">who changed what</span>
      </header>
      {first.error && !first.data ? (
        <div className="panel-body">
          <ErrorAlert
            error={first.error}
            title="Couldn't load the audit log."
            onRetry={first.reload}
          />
        </div>
      ) : all.length === 0 ? (
        <p className="panel-empty">
          {first.data
            ? "Nothing recorded yet. Changes to keys, endpoints, watches and your account will show here."
            : "Loading…"}
        </p>
      ) : (
        <ul className="audit">
          {all.map((row) => (
            <li key={row.id}>
              <span className="when">{dateTime(row.at)}</span>
              <span className="what">
                <b>{ACTIONS[row.action] ?? row.action}</b>
                {row.targetLabel && <span className="mono"> {row.targetLabel}</span>}
              </span>
              <span className="who">
                {row.actor === "api_key" ? "API key" : "Dashboard"}
                {row.ip ? ` · ${row.ip}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <div className="panel-foot">
          <button
            className="wh-btn is-sm"
            type="button"
            disabled={more.pending}
            onClick={() => void more.run(cursor)}
          >
            Show older
          </button>
        </div>
      )}
    </section>
  );
}

function Saved({ show }: { show: boolean }) {
  return show ? (
    <span className="kd-saved" role="status">
      <Icon name="check" size={14} className="ic-b" />
      Saved
    </span>
  ) : null;
}

export default function SettingsPage() {
  const router = useRouter();
  const { developer, reload } = useSession();
  const { choice, setChoice } = useTheme();
  const watches = useApi<{ data: Watch[] }>("/v1/watches");
  const endpoints = useApi<{ data: Endpoint[] }>("/v1/endpoints");
  const keys = useApi<{ data: ApiKey[] }>("/v1/api-keys");

  const [name, setName] = useState(developer.name ?? "");
  const [workspace, setWorkspace] = useState(developer.workspace ?? "");
  const [nameSaved, setNameSaved] = useState(false);
  const profileChanged =
    name.trim() !== (developer.name ?? "") || workspace.trim() !== (developer.workspace ?? "");
  const saveName = useAction(async () => {
    await api("/auth/me", {
      method: "PATCH",
      body: { ...(name.trim() ? { name: name.trim() } : {}), workspace: workspace.trim() || null },
    });
    setNameSaved(true);
    reload();
  });

  const [email, setEmail] = useState(developer.email);
  const [emailPassword, setEmailPassword] = useState("");
  const [emailSentTo, setEmailSentTo] = useState<string>();
  const changeEmail = useAction(async () => {
    const next = email.trim().toLowerCase();
    await api("/auth/email", { method: "POST", body: { email: next, password: emailPassword } });
    setEmailSentTo(next);
    setEmailPassword("");
  });
  const emailConflict =
    changeEmail.error?.code === "CONFLICT"
      ? "An account with this email already exists."
      : undefined;
  // Deleting everything is confirmed by typing the workspace's name, as the design asks.
  const CONFIRM_PHRASE = `delete ${(developer.workspace ?? "my account").toLowerCase()}`;

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordSaved, setPasswordSaved] = useState(false);
  const changePassword = useAction(async () => {
    await api("/auth/password", { method: "POST", body: { currentPassword, newPassword } });
    setCurrentPassword("");
    setNewPassword("");
    setPasswordSaved(true);
  });

  const logout = useAction(async () => {
    await api("/auth/logout", { method: "POST" });
    router.replace("/login");
  });

  const [phrase, setPhrase] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const deleteAccount = useAction(async () => {
    await api("/auth/me", { method: "DELETE", body: { password: deletePassword } });
    router.replace("/signup");
  });

  const count = (n: number | undefined, noun: string) =>
    `${n ?? "…"} ${n === 1 ? noun : `${noun}s`}`;

  return (
    <>
      <PageHead title="Settings" sub="Your account. Changes apply to this workspace only." />

      <section className="wh-panel">
        <header>
          <span className="h">Account</span>
          <Saved show={nameSaved && !saveName.pending} />
        </header>
        <form
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void saveName.run();
          }}
        >
          <div className="panel-body">
            <div className="form-grid">
              <Field id="name" label="Name">
                <input
                  id="name"
                  className="wh-input"
                  maxLength={100}
                  autoComplete="name"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameSaved(false);
                  }}
                />
              </Field>
              <Field
                id="workspace"
                label="Workspace"
                hint="Your company or project. Shown in the sidebar."
              >
                <input
                  id="workspace"
                  className="wh-input"
                  maxLength={100}
                  autoComplete="organization"
                  placeholder="Shopkit"
                  value={workspace}
                  onChange={(e) => {
                    setWorkspace(e.target.value);
                    setNameSaved(false);
                  }}
                />
              </Field>
            </div>
            {saveName.error && (
              <ErrorAlert error={saveName.error} title="Couldn't save your name." />
            )}
            {logout.error && <ErrorAlert error={logout.error} title="Couldn't log out." />}
          </div>
          <div className="panel-foot">
            <button
              className="wh-btn is-ghost"
              type="button"
              disabled={logout.pending}
              onClick={() => void logout.run()}
            >
              Log out
            </button>
            <button
              className="wh-btn is-primary"
              type="submit"
              disabled={!profileChanged || saveName.pending}
            >
              Save changes
            </button>
          </div>
        </form>
      </section>

      <section className="wh-panel">
        <header>
          <span className="h">Email</span>
        </header>
        <form
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void changeEmail.run();
          }}
        >
          <div className="panel-body">
            <div className="form-grid">
              <Field
                id="email"
                label="Email address"
                hint="Type a new address to change it. We'll send a confirmation link there; the change applies once you click it."
                error={emailConflict ?? issueText(changeEmail.error?.issueFor("email"))}
              >
                <input
                  id="email"
                  className="wh-input"
                  type="email"
                  autoComplete="email"
                  value={email}
                  aria-invalid={
                    emailConflict || changeEmail.error?.issueFor("email") ? true : undefined
                  }
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setEmailSentTo(undefined);
                  }}
                />
              </Field>
              <Field
                id="email-password"
                label="Your password"
                hint="To confirm it's you."
                error={issueText(changeEmail.error?.issueFor("password"))}
              >
                <input
                  id="email-password"
                  className="wh-input"
                  type="password"
                  autoComplete="current-password"
                  value={emailPassword}
                  aria-invalid={changeEmail.error?.issueFor("password") ? true : undefined}
                  onChange={(e) => setEmailPassword(e.target.value)}
                />
              </Field>
            </div>
            {emailSentTo && (
              <div className="wh-alert is-neutral" role="status">
                <Icon name="send" />
                <div className="body">
                  <strong>Check {emailSentTo}.</strong> Open the link we sent within 1 hour to
                  finish. Until then you still log in with {developer.email}.
                </div>
              </div>
            )}
            {changeEmail.error && !emailConflict && changeEmail.error.details.length === 0 && (
              <ErrorAlert error={changeEmail.error} title="Couldn't start the email change." />
            )}
          </div>
          <div className="panel-foot">
            <button
              className="wh-btn"
              type="submit"
              disabled={
                !emailPassword ||
                email.trim().toLowerCase() === developer.email ||
                !email.trim() ||
                changeEmail.pending
              }
            >
              Update email
            </button>
          </div>
        </form>
      </section>

      <section className="wh-panel">
        <header>
          <span className="h">Password</span>
          <Saved show={passwordSaved && !changePassword.pending} />
        </header>
        <form
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void changePassword.run();
          }}
        >
          <div className="panel-body">
            <div className="form-grid">
              <Field
                id="current-password"
                label="Current password"
                error={issueText(changePassword.error?.issueFor("currentPassword"))}
              >
                <input
                  id="current-password"
                  className="wh-input"
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  aria-invalid={
                    changePassword.error?.issueFor("currentPassword") ? true : undefined
                  }
                  onChange={(e) => {
                    setCurrentPassword(e.target.value);
                    setPasswordSaved(false);
                  }}
                />
              </Field>
              <Field
                id="new-password"
                label="New password"
                hint="Signs you out everywhere else."
                error={issueText(changePassword.error?.issueFor("newPassword"))}
              >
                <input
                  id="new-password"
                  className="wh-input"
                  type="password"
                  autoComplete="new-password"
                  placeholder="At least 10 characters"
                  value={newPassword}
                  aria-invalid={changePassword.error?.issueFor("newPassword") ? true : undefined}
                  onChange={(e) => {
                    setNewPassword(e.target.value);
                    setPasswordSaved(false);
                  }}
                />
              </Field>
            </div>
            {changePassword.error && changePassword.error.details.length === 0 && (
              <ErrorAlert error={changePassword.error} title="Couldn't change your password." />
            )}
          </div>
          <div className="panel-foot">
            <button
              className="wh-btn"
              type="submit"
              disabled={!currentPassword || !newPassword || changePassword.pending}
            >
              Change password
            </button>
          </div>
        </form>
      </section>

      <section className="wh-panel">
        <header>
          <span className="h">Appearance</span>
        </header>
        <div className="panel-body">
          <div className="opt-list" role="radiogroup" aria-label="Theme" style={{ maxWidth: 420 }}>
            {THEMES.map((theme) => (
              <button
                type="button"
                key={theme.value}
                className={choice === theme.value ? "opt is-on" : "opt"}
                role="radio"
                aria-checked={choice === theme.value}
                onClick={() => setChoice(theme.value)}
              >
                <span className="radio" aria-hidden="true" />
                <span className="grow">{theme.label}</span>
                <Icon name={theme.icon} />
              </button>
            ))}
          </div>
        </div>
      </section>

      <AuditLog />

      <section className="wh-panel danger-zone">
        <header>
          <span className="h">
            <Icon name="alert-triangle" />
            Delete account
          </span>
        </header>
        <div className="panel-body">
          <p className="hint" style={{ color: "var(--ink)" }}>
            Deletes your {developer.workspace ? "workspace" : "account"},{" "}
            {count(watches.data?.data.length, "watch").replace("watchs", "watches")},{" "}
            {count(endpoints.data?.data.length, "endpoint")},{" "}
            {count(keys.data?.data.length, "API key")} and all payment and webhook history. Webhooks
            stop immediately. This can't be undone.
          </p>
          <div className="form-grid">
            <div className="wh-field">
              <label htmlFor="delete-phrase">
                Type <span className="mono">{CONFIRM_PHRASE}</span> to confirm
              </label>
              <input
                id="delete-phrase"
                className="wh-input mono"
                placeholder={CONFIRM_PHRASE}
                autoComplete="off"
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
              />
            </div>
            <Field
              id="delete-password"
              label="Your password"
              error={issueText(deleteAccount.error?.issueFor("password"))}
            >
              <input
                id="delete-password"
                className="wh-input"
                type="password"
                autoComplete="current-password"
                value={deletePassword}
                aria-invalid={deleteAccount.error?.issueFor("password") ? true : undefined}
                onChange={(e) => setDeletePassword(e.target.value)}
              />
            </Field>
          </div>
          {deleteAccount.error && deleteAccount.error.details.length === 0 && (
            <ErrorAlert error={deleteAccount.error} title="Couldn't delete your account." />
          )}
        </div>
        <div className="panel-foot">
          <button
            className="wh-btn is-danger"
            type="button"
            disabled={phrase !== CONFIRM_PHRASE || !deletePassword || deleteAccount.pending}
            onClick={() => void deleteAccount.run()}
          >
            <Icon name="trash" />
            Delete account
          </button>
        </div>
      </section>
    </>
  );
}
