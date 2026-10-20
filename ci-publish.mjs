// Daily publisher, run by GitHub Actions in the scale-atlas-media repo (copied there by syncQueue() in scripts/post.mjs,
// with scripts/ci-publish.yml as its workflow), so posting works while the Mac is off. Node stdlib only.
// queue/<no>-<id>.json is written by the Mac on approval: only approved episodes, in order, up to the first gap.
// This posts the first unpublished one (at most one per KST day) to Instagram, then YouTube, then removes its media.
//   status: queued -> publishing -> published | failed (3 attempts, then /retry <id> on Telegram)
// DRY=1: check tokens and hosted files only. FORCE=1: ignore POST_TIME (manual run).
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const env = process.env;
const IG = 'https://graph.instagram.com/v25.0';
const Q = 'queue';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const kst = (d = new Date()) => new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short'}).format(d); // "2026-10-05 19:00"

// which entry to post now, or null: nothing out yet today, past POST_TIME, first unpublished in order, under 3 failed tries
export const pick = (entries, now = new Date(), force = false) => {
	const [day, time] = kst(now).split(' ');
	if (entries.some((x) => x.publishedAt && kst(new Date(x.publishedAt)).startsWith(day))) return null;
	if (!force && time < (env.POST_TIME ?? '19:00')) return null;
	const x = [...entries].sort((a, b) => a.no.localeCompare(b.no)).find((x) => x.status !== 'published');
	return x && !(x.status === 'failed' && (x.attempts ?? 0) >= 3) ? x : null;
};

const tg = async (text) => {
	if (!env.TG_TOKEN) return;
	await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify({chat_id: env.TG_CHAT_ID, text}),
		signal: AbortSignal.timeout(60000),
	}).catch(() => {});
};
const api = async (path, method = 'GET', params = {}) => {
	const url = new URL(`${IG}/${path}`);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	const res = await fetch(url, {method, headers: {Authorization: `Bearer ${env.IG_TOKEN}`}, signal: AbortSignal.timeout(60000)});
	const body = await res.json();
	if (!res.ok || body.error) throw new Error(`${method} ${path}: ${JSON.stringify(body.error ?? body)}`);
	return body;
};
// the hosted bytes must be exactly what was approved
const fetchChecked = async (f, hash) => {
	const res = await fetch(f.url, {signal: AbortSignal.timeout(120000)});
	if (!res.ok) throw new Error(`${f.url}: HTTP ${res.status}`);
	const b = Buffer.from(await res.arrayBuffer());
	if (sha(b) !== hash) throw new Error(`${f.url} is not the approved file`);
	return b;
};

// state that guards against a second post goes to the repo at once, not only at the end of the run
const commit = (msg) => {
	try {
		execFileSync('git', ['add', '-A']);
		execFileSync('git', ['commit', '-qm', msg]);
		try {
			execFileSync('git', ['push', '-q']);
		} catch {
			execFileSync('git', ['pull', '-q', '--rebase']);
			execFileSync('git', ['push', '-q']);
		}
	} catch (err) {
		console.error(`commit failed: ${String(err.message).slice(0, 200)}`);
	}
};
// already on Instagram (a run that posted but lost its state): its media id, else undefined
const posted = async (x) => {
	const {data} = await api(`${env.IG_USER_ID}/media`, 'GET', {fields: 'id,caption', limit: '10'});
	return data.find((m) => m.caption?.trim() === x.caption.trim())?.id;
};
const instagram = async (x, save) => {
	const already = await posted(x);
	if (already) return already;
	// a container from an earlier attempt: reuse it instead of creating a second post
	if (x.container) {
		const {status_code: code} = await api(x.container, 'GET', {fields: 'status_code'});
		if (code === 'PUBLISHED') return reconcile(x);
		if (code === 'ERROR' || code === 'EXPIRED') x.container = undefined;
	}
	if (!x.container) {
		({id: x.container} = await api(`${env.IG_USER_ID}/media`, 'POST', {media_type: 'REELS', video_url: x.video.url, cover_url: x.cover.url, caption: x.caption.trim(), share_to_feed: 'true'}));
		save();
		commit(`Container for ${x.id}`);
	}
	// docs: poll about once a minute, up to 5 minutes
	for (let i = 0; ; i++) {
		await sleep(i ? 60000 : 30000);
		const {status_code: code, status} = await api(x.container, 'GET', {fields: 'status_code,status'});
		if (code === 'FINISHED') break;
		if (code === 'PUBLISHED') return reconcile(x);
		if (code === 'ERROR' || code === 'EXPIRED' || i >= 6) {
			x.container = undefined;
			throw new Error(`container ${code}: ${status ?? ''}`);
		}
	}
	return (await api(`${env.IG_USER_ID}/media_publish`, 'POST', {creation_id: x.container})).id;
};
// published but the media id was lost (run killed between publish and save): find it by caption
const reconcile = async (x) => {
	const id = await posted(x);
	if (!id) throw new Error(`container published but no matching media found for ${x.id}`);
	return id;
};

const ytToken = async () => {
	const body = new URLSearchParams({client_id: env.YT_CLIENT_ID, client_secret: env.YT_CLIENT_SECRET, refresh_token: env.YT_REFRESH_TOKEN ?? '', grant_type: 'refresh_token'});
	const b = await (await fetch('https://oauth2.googleapis.com/token', {method: 'POST', body, signal: AbortSignal.timeout(60000)})).json();
	if (!b.access_token) throw new Error(`유튜브 재인증 필요: node scripts/yt-auth.mjs 후 YT_REFRESH_TOKEN 시크릿 갱신 (${b.error})`);
	return b.access_token;
};
const youtube = async (x, video) => {
	const meta = {
		snippet: {title: x.caption.split('\n')[0].slice(0, 100), description: x.caption, categoryId: '28', defaultLanguage: 'ko'},
		status: {privacyStatus: env.YT_PRIVACY || 'private', selfDeclaredMadeForKids: false},
	};
	const auth = {Authorization: `Bearer ${await ytToken()}`};
	const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
		method: 'POST',
		headers: {...auth, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(video.length)},
		body: JSON.stringify(meta),
		signal: AbortSignal.timeout(60000),
	});
	if (!init.ok) throw new Error(`youtube init ${init.status}: ${(await init.text()).slice(0, 300)}`);
	const b = await (await fetch(init.headers.get('location'), {method: 'PUT', headers: {...auth, 'Content-Type': 'video/mp4'}, body: video, signal: AbortSignal.timeout(600000)})).json();
	if (!b.id) throw new Error(`youtube upload: ${JSON.stringify(b.error ?? b).slice(0, 300)}`);
	return {id: b.id, privacy: b.status?.privacyStatus, at: new Date().toISOString()};
};
const ytLine = (y) => `\n\n▶️ 유튜브 https://youtube.com/shorts/${y.id}${y.privacy === 'private' ? ' (비공개)' : ''}`;
// YouTube rides along with each post; a failed upload is retried on the next runs (3 tries), then the media is removed
const ytTry = async (x, video) => {
	if (!env.YT_REFRESH_TOKEN) return '';
	try {
		x.youtube = await youtube(x, video ?? (await fetchChecked(x.video, x.hashes.video)));
		return ytLine(x.youtube);
	} catch (err) {
		x.ytAttempts = (x.ytAttempts ?? 0) + 1;
		return `\n\n⚠️ 유튜브 업로드 실패 (${x.ytAttempts}/3): ${err.message}`;
	}
};
const unhost = (x) => {
	if (x.unhosted || !(x.youtube || (x.ytAttempts ?? 0) >= 3 || !env.YT_REFRESH_TOKEN)) return;
	for (const f of [x.video, x.cover]) rmSync(f.name, {force: true});
	x.unhosted = true;
};

const main = async () => {
	const files = existsSync(Q) ? readdirSync(Q).filter((f) => f.endsWith('.json')) : [];
	const entries = files.map((f) => ({f: join(Q, f), x: JSON.parse(readFileSync(join(Q, f), 'utf8'))}));
	const write = ({f, x}) => writeFileSync(f, JSON.stringify(x, null, '\t') + '\n');

	if (env.DRY) {
		await api('me', 'GET', {fields: 'username'});
		if (env.YT_REFRESH_TOKEN) await ytToken();
		for (const {x} of entries.filter(({x}) => x.status !== 'published')) for (const k of ['video', 'cover']) await fetchChecked(x[k], x.hashes[k]);
		console.log(`dry run ok: tokens work, ${entries.filter(({x}) => x.status !== 'published').length} queued files serve the approved bytes`);
		return;
	}
	// YouTube retries for earlier posts
	for (const e of entries.filter(({x}) => x.status === 'published' && !x.unhosted)) {
		if (!e.x.youtube && (e.x.ytAttempts ?? 0) < 3) {
			const line = await ytTry(e.x);
			if (e.x.youtube) await tg(`${e.x.no} ${e.x.id}${line}`);
		}
		unhost(e.x);
		write(e);
	}
	const x = pick(
		entries.map((e) => e.x),
		new Date(),
		!!env.FORCE,
	);
	if (!x) return console.log('nothing to post now');
	const e = entries.find((e) => e.x === x);
	x.status = 'publishing';
	x.attempts = (x.attempts ?? 0) + 1;
	x.error = undefined;
	write(e);
	try {
		const video = await fetchChecked(x.video, x.hashes.video);
		await fetchChecked(x.cover, x.hashes.cover);
		if (sha(x.caption) !== x.hashes.caption) throw new Error('caption is not the approved one');
		x.media = await instagram(x, () => write(e));
		x.permalink = (await api(x.media, 'GET', {fields: 'permalink'})).permalink;
		Object.assign(x, {status: 'published', publishedAt: new Date().toISOString(), container: undefined});
		write(e);
		commit(`Published ${x.id}`);
		console.log(`published ${x.id}`);
		const line = await ytTry(x, video);
		unhost(x);
		write(e);
		await tg(`🎉 ${x.no} ${x.id} 게시됨\n${x.permalink}\n\n📲 스토리 공유: 링크 열기 → 종이비행기 → 스토리에 추가${line}`);
	} catch (err) {
		Object.assign(x, {status: 'failed', error: String(err.message ?? err).slice(0, 500)});
		write(e);
		console.error(`publish failed: ${x.error}`);
		await tg(`⚠️ ${x.no} ${x.id} 게시 실패 (시도 ${x.attempts}/3)\n${x.error}${x.attempts >= 3 ? `\n\n/retry ${x.id} 로 다시 시도` : '\n\n다음 예약 시각에 다시 시도'}`);
		process.exitCode = 1;
	}
};
if (import.meta.url === `file://${process.argv[1]}`) await main();
