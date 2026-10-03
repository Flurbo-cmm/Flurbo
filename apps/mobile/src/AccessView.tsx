import { useEffect, useState } from 'react';
import { View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { api } from './api';
import { auth } from './runtime';
import { Button, Card, Copy, Field, Heading, Notice, Title, s } from './ui';

export type ApplicationState = 'unverified' | 'pending' | 'approved' | 'declined' | 'revoked' | 'withdrawn';
export type Application = {
  account: string;
  email: string | null;
  state: ApplicationState;
  verified: boolean;
  revision: number;
  createdAt: string;
  notification: string;
};

export function AccessView({ onApproved }: { onApproved: () => void }) {
  const login = auth.getSnapshot();
  const [application, setApplication] = useState<Application | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [copied, setCopied] = useState('');

  async function checkAccess() {
    setError('');
    try {
      const access = await api<{ approved: boolean }>('/api/account/access');
      if (access.approved) {
        onApproved();
        return true;
      }
    } catch {
      // Keep checking application
    }
    return false;
  }

  async function loadApplication() {
    setLoading(true);
    setError('');
    try {
      const isApproved = await checkAccess();
      if (isApproved) return;
      const res = await api<{ application?: Application | null }>('/api/account/application');
      setApplication(res.application || null);
      if (res.application?.email) setEmail(res.application.email);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check application status.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadApplication();
  }, []);

  async function submitApplication() {
    if (busy || !email || !accepted) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await api<{ application?: Application; message?: string }>('/api/account/application/submit', {
        email: email.trim(),
        noticeAccepted: accepted,
      });
      setApplication(res.application || null);
      setNotice(res.message || 'Check your inbox for a six-digit verification code.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Application submission failed.');
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode() {
    if (busy || !code) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await api<{ application?: Application; message?: string }>('/api/account/application/verify', {
        code: code.trim(),
      });
      setApplication(res.application || null);
      setNotice(res.message || 'Email verified. Your request is now ready for review.');
      await checkAccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verification failed.');
    } finally {
      setBusy(false);
    }
  }

  const state = application?.state;
  const canApply = !application || state === 'withdrawn';
  const isUnverified = state === 'unverified';
  const isPending = state === 'pending' || (application?.verified && state !== 'declined');

  return (
    <>
      <Title>Your place in the preview.</Title>
      <Copy>Flurbo is on Monad testnet. Previews require access approval from the Flurbo team.</Copy>

      <Card>
        <Heading>Your Flurbo account</Heading>
        <Copy small>MERA PASSKEY IDENTITY</Copy>
        <Copy>{login.address}</Copy>
        <Button
          secondary
          title={copied || 'Copy address'}
          onPress={() => void Clipboard.setStringAsync(login.address || '').then(() => setCopied('Address copied.'))}
        />
      </Card>

      <Notice>{error || notice}</Notice>

      {loading ? (
        <Card>
          <Copy>Checking access status...</Copy>
        </Card>
      ) : canApply ? (
        <Card>
          <Heading>Request your invitation</Heading>
          <Copy>Leave your email. The Flurbo team will review your request and approve your account.</Copy>
          <Field label="Email address" value={email} onChange={setEmail} />
          <View style={{ gap: 8 }}>
            <Button
              secondary={!accepted}
              title={accepted ? 'Consent confirmed' : 'Confirm consent: notices and access updates'}
              onPress={() => setAccepted(!accepted)}
            />
            <Copy small>Flurbo uses your email strictly for access status and account notifications.</Copy>
          </View>
          <Button
            title={busy ? 'Submitting...' : 'Request access'}
            disabled={busy || !email || !accepted}
            onPress={() => void submitApplication()}
          />
        </Card>
      ) : isUnverified ? (
        <Card>
          <Heading>Verify your email</Heading>
          <Copy>Enter the six-digit code sent to {application?.email}. It expires after 10 minutes.</Copy>
          <Field label="Six-digit verification code" value={code} onChange={setCode} numeric />
          <Button title={busy ? 'Verifying...' : 'Submit code'} disabled={busy || !code} onPress={() => void verifyCode()} />
        </Card>
      ) : (
        <Card>
          <Heading>{state === 'declined' ? 'Not selected this round' : 'Application under review'}</Heading>
          <Copy>
            {state === 'declined'
              ? 'Your application was not approved for this preview round.'
              : 'Your email has been verified. The team reviews requests manually. Once approved, you can explore markets and trade.'}
          </Copy>
          <Button
            title={busy ? 'Checking...' : 'Check approval status'}
            disabled={busy}
            onPress={() => {
              setBusy(true);
              void checkAccess().finally(() => setBusy(false));
            }}
          />
        </Card>
      )}

      <Button secondary title="Sign out" onPress={() => void auth.signOut()} />
    </>
  );
}
