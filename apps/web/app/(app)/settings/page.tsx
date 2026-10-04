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
import type { ApiKey, Endpoint, Watch } from "@/lib/types";

const THEMES: { value: ThemeChoice; label: string; icon: IconName }[] = [
  { value: "system", label: "Match system", icon: "monitor" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];
const CONFIRM_PHRASE = "delete my account";

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
  const [nameSaved, setNameSaved] = useState(false);
  const saveName = useAction(async () => {
    await api("/auth/me", { method: "PATCH", body: { name: name.trim() } });
    setNameSaved(true);
    reload();
  });

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

  const count = (n: number | undefined, noun: string) => `${n ?? "…"} ${n === 1 ? noun : `${noun}s`}`;

  return (
    <>
      <PageHead title="Settings" sub="Your account." />

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
              <Field id="email" label="Email address" hint="Your login. It can't be changed here yet.">
                <input id="email" className="wh-input" type="email" value={developer.email} readOnly aria-describedby="email-hint" />
              </Field>
            </div>
            {saveName.error && <ErrorAlert error={saveName.error} title="Couldn't save your name." />}
            {logout.error && <ErrorAlert error={logout.error} title="Couldn't log out." />}
          </div>
          <div className="panel-foot">
            <button className="wh-btn is-ghost" type="button" disabled={logout.pending} onClick={() => void logout.run()}>
              Log out
            </button>
            <button className="wh-btn is-primary" type="submit" disabled={!name.trim() || name.trim() === (developer.name ?? "") || saveName.pending}>
              Save changes
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
              <Field id="current-password" label="Current password" error={issueText(changePassword.error?.issueFor("currentPassword"))}>
                <input
                  id="current-password"
                  className="wh-input"
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  aria-invalid={changePassword.error?.issueFor("currentPassword") ? true : undefined}
                  onChange={(e) => {
                    setCurrentPassword(e.target.value);
                    setPasswordSaved(false);
                  }}
                />
              </Field>
              <Field id="new-password" label="New password" hint="Signs you out everywhere else." error={issueText(changePassword.error?.issueFor("newPassword"))}>
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
            {changePassword.error && changePassword.error.details.length === 0 && <ErrorAlert error={changePassword.error} title="Couldn't change your password." />}
          </div>
          <div className="panel-foot">
            <button className="wh-btn" type="submit" disabled={!currentPassword || !newPassword || changePassword.pending}>
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
              <button type="button" key={theme.value} className={choice === theme.value ? "opt is-on" : "opt"} role="radio" aria-checked={choice === theme.value} onClick={() => setChoice(theme.value)}>
                <span className="radio" aria-hidden="true" />
                <span className="grow">{theme.label}</span>
                <Icon name={theme.icon} />
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="wh-panel danger-zone">
        <header>
          <span className="h">
            <Icon name="alert-triangle" />
            Delete account
          </span>
        </header>
        <div className="panel-body">
          <p className="hint" style={{ color: "var(--ink)" }}>
            Deletes your account, {count(watches.data?.data.length, "watch").replace("watchs", "watches")}, {count(endpoints.data?.data.length, "endpoint")}, {count(keys.data?.data.length, "API key")} and all payment and webhook history. Webhooks stop immediately. This can't be undone.
          </p>
          <div className="form-grid">
            <div className="wh-field">
              <label htmlFor="delete-phrase">
                Type <span className="mono">{CONFIRM_PHRASE}</span> to confirm
              </label>
              <input id="delete-phrase" className="wh-input mono" placeholder={CONFIRM_PHRASE} autoComplete="off" value={phrase} onChange={(e) => setPhrase(e.target.value)} />
            </div>
            <Field id="delete-password" label="Your password" error={issueText(deleteAccount.error?.issueFor("password"))}>
              <input id="delete-password" className="wh-input" type="password" autoComplete="current-password" value={deletePassword} aria-invalid={deleteAccount.error?.issueFor("password") ? true : undefined} onChange={(e) => setDeletePassword(e.target.value)} />
            </Field>
          </div>
          {deleteAccount.error && deleteAccount.error.details.length === 0 && <ErrorAlert error={deleteAccount.error} title="Couldn't delete your account." />}
        </div>
        <div className="panel-foot">
          <button className="wh-btn is-danger" type="button" disabled={phrase !== CONFIRM_PHRASE || !deletePassword || deleteAccount.pending} onClick={() => void deleteAccount.run()}>
            <Icon name="trash" />
            Delete account
          </button>
        </div>
      </section>
    </>
  );
}
