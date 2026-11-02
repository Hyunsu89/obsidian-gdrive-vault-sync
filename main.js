/*
 * GDrive Vault Sync
 *
 *   0단계  연결 확인 · 전체 스캔          (읽기만)
 *   1단계  다운로드 — Drive → 로컬         (로컬에만 씀. Drive 무손상)
 *   2단계  업로드 — 새 파일만              (예정)
 *
 * 설계 원칙 — 2026-10 중복 사태에서 얻은 교훈을 구조로 박아 둔다.
 *   1. 상태 파일을 만들지 않는다.
 *      changesToken·lastSyncedAt 같은 기기별 값을 저장하지 않고 매번 Drive 를 직접 조회한다.
 *      기기 사이에 덮어쓸 상태가 없으므로 다기기에서 어긋날 수가 없다.
 *   2. `.obsidian/` 을 절대 건드리지 않는다. 설정 폴더 동기화가 그 사고의 뿌리였다.
 *   3. 삭제하지 않는다. Drive 에 없는 로컬 파일은 그대로 둔다.
 *   4. 로컬이 더 최신이면 덮어쓰지 않는다. 아직 안 올린 회의록을 지키기 위해서다.
 *
 * 빌드 도구를 쓰지 않는다. 이 파일이 곧 배포본이다.
 */

const { Plugin, PluginSettingTab, Setting, Notice, requestUrl } = require("obsidian");

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";

const DEFAULT_SETTINGS = {
	clientId: "",
	clientSecret: "",
	refreshToken: "",
	rootFolderId: "",
	// 내려받지 않을 최상위 폴더. `.obsidian` 은 설정에 없어도 항상 제외한다.
	excludes: "_migration, _attachments, 90_Archive",
};

/** 항상 제외 — 설정으로도 풀 수 없다. 2번 원칙. */
const ALWAYS_EXCLUDE = [".obsidian", ".trash"];

function formBody(obj) {
	// URLSearchParams 대신 직접 만든다. 모바일 웹뷰 차이를 타지 않기 위해서다.
	return Object.keys(obj)
		.map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(obj[k]))
		.join("&");
}

class GDriveVaultSync extends Plugin {
	async onload() {
		await this.loadSettings();
		this.addSettingTab(new GDriveSettingTab(this.app, this));

		const cmd = (id, name, fn) =>
			this.addCommand({ id, name, callback: () => this.run(fn) });

		cmd("check-connection", "Drive 연결 확인", () => this.checkConnection());
		cmd("scan-drive", "Drive 전체 스캔 (읽기만)", () => this.scanDrive());
		cmd("download-preview", "Drive 다운로드 — 미리보기", () => this.download(true));
		cmd("download-run", "Drive 다운로드 — 실행", () => this.download(false));

		this.addRibbonIcon("cloud-download", "Drive 다운로드 미리보기", () =>
			this.run(() => this.download(true)),
		);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** 오류를 Notice 로 보여준다. iOS 에는 콘솔이 없어서 이게 유일한 창구다. */
	async run(fn) {
		if (this.busy) {
			new Notice("이미 실행 중이다");
			return;
		}
		this.busy = true;
		try {
			await fn();
		} catch (e) {
			console.error(e);
			new Notice("❌ " + (e && e.message ? e.message : String(e)), 15000);
		} finally {
			this.busy = false;
		}
	}

	// ---------------------------------------------------------------- 인증

	async getAccessToken() {
		const s = this.settings;
		for (const [k, label] of [
			["clientId", "클라이언트 ID"],
			["clientSecret", "클라이언트 시크릿"],
			["refreshToken", "refresh token"],
			["rootFolderId", "루트 폴더 ID"],
		]) {
			if (!s[k] || !s[k].trim()) throw new Error(`설정이 비어 있다: ${label}`);
		}

		const res = await requestUrl({
			url: TOKEN_URL,
			method: "POST",
			contentType: "application/x-www-form-urlencoded",
			body: formBody({
				client_id: s.clientId.trim(),
				client_secret: s.clientSecret.trim(),
				refresh_token: s.refreshToken.trim(),
				grant_type: "refresh_token",
			}),
			throw: false,
		});

		if (res.status !== 200) {
			const detail = (res.text || "").slice(0, 200);
			if (detail.includes("invalid_grant")) {
				throw new Error("토큰이 만료·폐기됐다 (invalid_grant). 새 refresh token 이 필요하다.");
			}
			throw new Error(`토큰 요청 실패 ${res.status}: ${detail}`);
		}
		return res.json.access_token;
	}

	// ---------------------------------------------------------------- 조회

	/** 한 폴더의 자식 목록. 페이지가 나뉘어 와도 전부 모은다. */
	async listChildren(token, folderId) {
		const out = [];
		let pageToken = null;
		do {
			const params = [
				"q=" + encodeURIComponent(`'${folderId}' in parents and trashed = false`),
				"fields=" + encodeURIComponent("nextPageToken,files(id,name,mimeType,modifiedTime,size)"),
				"pageSize=1000",
				"supportsAllDrives=true",
			];
			if (pageToken) params.push("pageToken=" + encodeURIComponent(pageToken));

			const res = await requestUrl({
				url: API + "?" + params.join("&"),
				method: "GET",
				headers: { Authorization: "Bearer " + token },
				throw: false,
			});
			if (res.status !== 200) {
				throw new Error(`목록 조회 실패 ${res.status}: ${(res.text || "").slice(0, 200)}`);
			}
			out.push(...(res.json.files || []));
			pageToken = res.json.nextPageToken || null;
		} while (pageToken);
		return out;
	}

	excludeList() {
		const user = (this.settings.excludes || "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		return ALWAYS_EXCLUDE.concat(user);
	}

	/**
	 * Drive 전체를 훑어 경로 -> 파일 정보 로 만든다.
	 * 폴더는 결과에 넣지 않는다. 내려받을 때 필요한 만큼 만들면 된다.
	 */
	async buildTree(token, onProgress) {
		const excludes = this.excludeList();
		const files = new Map();
		let calls = 0;

		const walk = async (folderId, relPath) => {
			calls++;
			if (onProgress && calls % 5 === 0) onProgress(files.size, calls);
			for (const c of await this.listChildren(token, folderId)) {
				// 제외는 최상위에서만 판단한다
				if (!relPath && excludes.includes(c.name)) continue;
				const path = relPath ? relPath + "/" + c.name : c.name;
				if (c.mimeType === FOLDER_MIME) {
					await walk(c.id, path);
				} else {
					files.set(path, c);
				}
			}
		};

		await walk(this.settings.rootFolderId.trim(), "");
		return { files, calls };
	}

	// ---------------------------------------------------------------- 0단계

	async checkConnection() {
		new Notice("연결 확인 중…");
		const token = await this.getAccessToken();
		const children = await this.listChildren(token, this.settings.rootFolderId.trim());
		const dirs = children.filter((f) => f.mimeType === FOLDER_MIME);
		new Notice(
			[
				"✅ 연결 성공",
				`최상위 폴더 ${dirs.length}개 · 파일 ${children.length - dirs.length}개`,
				"",
				dirs.map((d) => "  " + d.name).join("\n"),
			].join("\n"),
			15000,
		);
	}

	async scanDrive() {
		const notice = new Notice("전체 스캔 중…", 0);
		const token = await this.getAccessToken();
		const { files, calls } = await this.buildTree(token, (n, c) =>
			notice.setMessage(`스캔 중… 파일 ${n}개 · 폴더 ${c}개`),
		);

		const perTop = {};
		let bytes = 0;
		for (const [path, f] of files) {
			const top = path.includes("/") ? path.split("/")[0] : "(루트)";
			perTop[top] = (perTop[top] || 0) + 1;
			bytes += Number(f.size || 0);
		}
		notice.hide();
		new Notice(
			[
				"✅ 스캔 완료 (읽기만 함)",
				`파일 ${files.size}개 · ${(bytes / 1048576).toFixed(1)} MB · API ${calls}회`,
				`제외: ${this.excludeList().join(", ")}`,
				"",
				Object.keys(perTop)
					.sort((a, b) => perTop[b] - perTop[a])
					.map((k) => `  ${k}: ${perTop[k]}`)
					.join("\n"),
			].join("\n"),
			20000,
		);
	}

	// ---------------------------------------------------------------- 1단계

	/** 부모 폴더를 위에서부터 만든다. 이미 있으면 넘어간다. */
	async ensureFolder(path) {
		const parts = path.split("/");
		parts.pop(); // 파일명 제거
		let cur = "";
		for (const p of parts) {
			cur = cur ? cur + "/" + p : p;
			if (!(await this.app.vault.adapter.exists(cur))) {
				try {
					await this.app.vault.adapter.mkdir(cur);
				} catch (e) {
					// 동시 생성 경합은 무시한다
				}
			}
		}
	}

	/**
	 * Drive -> 로컬. **로컬에만 쓴다. Drive 는 읽기만 한다.**
	 * preview 가 true 면 아무것도 쓰지 않고 계획만 보여준다.
	 */
	async download(preview) {
		const notice = new Notice(preview ? "미리보기 계산 중…" : "다운로드 준비 중…", 0);
		const token = await this.getAccessToken();
		const adapter = this.app.vault.adapter;
		const { files } = await this.buildTree(token, (n, c) =>
			notice.setMessage(`목록 수집 중… ${n}개`),
		);

		const toAdd = [];      // 로컬에 없음
		const toUpdate = [];   // Drive 가 더 최신
		const keepLocal = [];  // 로컬이 더 최신 -> 건드리지 않는다
		const skipGoogle = []; // Google 문서 형식 -> 내려받을 수 없다

		for (const [path, f] of files) {
			if (f.mimeType && f.mimeType.startsWith("application/vnd.google-apps.")) {
				skipGoogle.push(path);
				continue;
			}
			const stat = await adapter.stat(path).catch(() => null);
			if (!stat) {
				toAdd.push(path);
			} else {
				const driveMs = Date.parse(f.modifiedTime || 0);
				if (driveMs > (stat.mtime || 0)) toUpdate.push(path);
				else keepLocal.push(path);
			}
		}

		if (preview) {
			notice.hide();
			const sample = (arr) =>
				arr.slice(0, 5).map((p) => "   " + p).join("\n") +
				(arr.length > 5 ? `\n   … 외 ${arr.length - 5}개` : "");
			const lines = [
				"📋 다운로드 미리보기 (아무것도 쓰지 않았다)",
				"",
				`새로 받을 파일   ${toAdd.length}개`,
				toAdd.length ? sample(toAdd) : "",
				`덮어쓸 파일      ${toUpdate.length}개  (Drive 가 더 최신)`,
				toUpdate.length ? sample(toUpdate) : "",
				`그대로 둘 파일   ${keepLocal.length}개  (로컬이 최신이거나 동일)`,
				skipGoogle.length ? `건너뜀(구글문서) ${skipGoogle.length}개` : "",
				"",
				"실행하려면 «Drive 다운로드 — 실행»",
			].filter(Boolean);
			new Notice(lines.join("\n"), 30000);
			return;
		}

		const targets = toAdd.concat(toUpdate);
		if (!targets.length) {
			notice.hide();
			new Notice("받을 파일이 없다. 이미 최신이다.");
			return;
		}

		let done = 0, failed = 0;
		const errors = [];
		for (const path of targets) {
			const f = files.get(path);
			try {
				const res = await requestUrl({
					url: `${API}/${f.id}?alt=media&supportsAllDrives=true`,
					method: "GET",
					headers: { Authorization: "Bearer " + token },
					throw: false,
				});
				if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
				await this.ensureFolder(path);
				// 바이트 그대로 쓴다. vault 가 CRLF 라 텍스트 변환을 거치지 않는 편이 안전하다.
				await adapter.writeBinary(path, res.arrayBuffer);
				done++;
			} catch (e) {
				failed++;
				if (errors.length < 3) errors.push(`${path}: ${e.message}`);
			}
			if (done % 10 === 0 || done + failed === targets.length) {
				notice.setMessage(`다운로드 ${done + failed}/${targets.length}…`);
			}
		}

		notice.hide();
		new Notice(
			[
				failed ? "⚠️ 다운로드 완료 (일부 실패)" : "✅ 다운로드 완료",
				`받음 ${done}개 · 실패 ${failed}개 · 건드리지 않음 ${keepLocal.length}개`,
				errors.length ? "\n" + errors.join("\n") : "",
			].join("\n"),
			20000,
		);
	}
}

// ---------------------------------------------------------------- 설정 화면

class GDriveSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h3", { text: "Google Drive 연결" });
		containerEl.createEl("p", {
			text: "자격증명은 이 기기에만 저장된다. .obsidian 은 동기화 대상이 아니므로 다른 기기로 넘어가지 않는다.",
		});

		const text = (name, desc, key, placeholder) =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addText((t) =>
					t
						.setPlaceholder(placeholder || "")
						.setValue(this.plugin.settings[key])
						.onChange(async (v) => {
							this.plugin.settings[key] = v;
							await this.plugin.saveSettings();
						}),
				);

		text("클라이언트 ID", "Google Cloud OAuth 클라이언트 (데스크톱 앱)", "clientId", "…apps.googleusercontent.com");
		text("클라이언트 시크릿", "같은 클라이언트의 시크릿", "clientSecret", "GOCSPX-…");
		text("Refresh token", "서버에서 발급한 값을 붙여넣는다", "refreshToken", "1//0e…");
		text("루트 폴더 ID", "Drive 의 vault 폴더 ID", "rootFolderId", "10AlHx…");
		text("제외할 최상위 폴더", "쉼표로 구분. .obsidian 과 .trash 는 항상 제외된다", "excludes", "_migration, _attachments");
	}
}

module.exports = GDriveVaultSync;
