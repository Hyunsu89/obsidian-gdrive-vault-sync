/*
 * GDrive Vault Sync
 *
 *   0단계  연결 확인 · 전체 스캔          (읽기만)
 *   1단계  다운로드 — Drive → 로컬         (로컬에만 씀. Drive 무손상)
 *   2단계  업로드 — 새 파일만              (기존 파일 수정·삭제 불가)
 *   3단계  자동화 — 열 때 받고, 새 노트는 잠시 뒤 올린다
 *
 * 설계 원칙 — 2026-10 중복 사태에서 얻은 교훈을 구조로 박아 둔다.
 *   1. **판단에 저장된 상태를 쓰지 않는다.**
 *      무엇을 받고 올릴지는 매번 Drive 를 직접 조회해 정한다.
 *      구 플러그인은 changesToken·lastSyncedAt 을 저장했고 그 값이 기기 간에
 *      공유되면서 "이미 처리했다"고 착각해 중복을 쏟아냈다.
 *      (자동 실행 간격을 재는 타임스탬프는 저장하지만, 그 값은 **얼마나 자주 도는지**에만
 *       영향을 주고 **무엇을 쓰는지**에는 관여하지 않는다. 틀려도 손실이 없다.)
 *   2. `.obsidian/` 을 절대 건드리지 않는다. 설정 폴더 동기화가 그 사고의 뿌리였다.
 *   3. 삭제하지 않는다. Drive 에 없는 로컬 파일은 그대로 둔다.
 *   4. 로컬이 더 최신이면 덮어쓰지 않는다. 아직 안 올린 회의록을 지키기 위해서다.
 *   5. 자동화해도 위 네 가지는 그대로다. 그래서 자동으로 돌아도 파괴적 동작이 없다.
 *
 * 빌드 도구를 쓰지 않는다. 이 파일이 곧 배포본이다.
 */

const { Plugin, PluginSettingTab, Setting, Notice, Modal, requestUrl } = require("obsidian");

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
	// --- 자동화 ---
	autoDownloadOnOpen: true,
	autoDownloadGapMin: 60,     // 이 시간 안에 이미 돌았으면 건너뛴다
	autoUploadNew: true,
	autoUploadDelaySec: 60,     // 새 노트를 만들고 이만큼 조용하면 올린다
	lastAutoDownload: 0,        // 간격 계산용. 판단 로직에는 관여하지 않는다
};

/** 항상 제외 — 설정으로도 풀 수 없다. 2번 원칙. */
const ALWAYS_EXCLUDE = [".obsidian", ".trash"];

/**
 * 노트 자동생성 — PC 의 QuickAdd 설정 3개를 그대로 옮겨 왔다.
 * 설정 화면이 따로 없는 것이 장점이다. 기기를 바꿔도 다시 맞출 일이 없다.
 */
const NOTE_TYPES = [
	{
		id: "meeting",
		name: "회의록 만들기 — 업무회의",
		template: "90_Templates/업무회의.md",
		folder: "10_회의록/아이웍스/{{date:YYYY}}",
		filename: "{{date:YYMMDD}} - {{VALUE}}",
		prompt: "회의 이름",
	},
	{
		id: "weekly",
		name: "회의록 만들기 — 주간회의",
		template: "90_Templates/주간회의.md",
		folder: "10_회의록/아이웍스/{{date:YYYY}}",
		filename: "{{date:YYMMDD}} - 주간회의",
	},
	{
		id: "monthly",
		name: "업무일지 만들기 — 이번 달",
		template: "90_Templates/월간일지.md",
		folder: "20_업무관리/일지/{{date:YYYY}}",
		filename: "{{date:YYYY-MM}}",
	},
];

/**
 * 템플릿 치환. Obsidian 코어 템플릿과 QuickAdd 양쪽 문법을 다 받는다.
 *   {{date:FMT}} {{time:FMT}} {{DATE:FMT}}  — moment 포맷. [W]WW 처럼 대괄호 이스케이프도 그대로 통한다
 *   {{date}} {{time}}                        — 기본 포맷
 *   {{VALUE}} {{value}} {{title}}            — 사용자가 입력한 값
 */
function fillTemplate(text, value) {
	const m = window.moment();
	return text
		.replace(/\{\{(?:date|time):([^}]+)\}\}/gi, (_, fmt) => m.format(fmt))
		.replace(/\{\{date\}\}/gi, m.format("YYYY-MM-DD"))
		.replace(/\{\{time\}\}/gi, m.format("HH:mm"))
		.replace(/\{\{(?:value|title)\}\}/gi, value || "");
}

/** 파일명에 쓸 수 없는 문자를 걷어낸다. */
function safeName(s) {
	return s.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim();
}

class PromptModal extends Modal {
	constructor(app, title, onSubmit) {
		super(app);
		this.title = title;
		this.onSubmit = onSubmit;
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.title });
		const input = contentEl.createEl("input", { type: "text" });
		input.style.width = "100%";
		const submit = () => {
			const v = input.value.trim();
			if (!v) return;
			this.close();
			this.onSubmit(v);
		};
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") submit();
		});
		const btn = contentEl.createEl("button", { text: "만들기" });
		btn.style.marginTop = "12px";
		btn.addEventListener("click", submit);
		window.setTimeout(() => input.focus(), 50);
	}
	onClose() {
		this.contentEl.empty();
	}
}

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

		this.pendingUploads = new Set();
		this.suppressEvents = false;

		const cmd = (id, name, fn) =>
			this.addCommand({ id, name, callback: () => this.run(fn) });

		cmd("check-connection", "Drive 연결 확인", () => this.checkConnection());
		cmd("scan-drive", "Drive 전체 스캔 (읽기만)", () => this.scanDrive());
		cmd("download-preview", "Drive 다운로드 — 미리보기", () => this.download(true));
		cmd("download-run", "Drive 다운로드 — 실행", () => this.download(false));
		cmd("upload-preview", "Drive 업로드 — 미리보기", () => this.upload(true));
		cmd("upload-run", "Drive 업로드 — 실행", () => this.upload(false));
		cmd("sync-now", "지금 동기화 (받기 → 올리기)", () => this.syncNow());

		for (const t of NOTE_TYPES) {
			this.addCommand({
				id: "new-" + t.id,
				name: t.name,
				callback: () => {
					if (t.prompt) {
						new PromptModal(this.app, t.prompt, (v) =>
							this.run(() => this.createNote(t, v)),
						).open();
					} else {
						this.run(() => this.createNote(t, ""));
					}
				},
			});
		}

		this.addRibbonIcon("refresh-cw", "지금 동기화", () => this.run(() => this.syncNow()));
		this.addRibbonIcon("file-plus", "회의록 만들기", () =>
			new PromptModal(this.app, "회의 이름", (v) =>
				this.run(() => this.createNote(NOTE_TYPES[0], v)),
			).open(),
		);

		// vault 가 다 뜬 뒤에 건다. 그 전에 걸면 기존 파일이 전부 create 로 들어온다.
		this.app.workspace.onLayoutReady(() => {
			this.registerEvent(
				this.app.vault.on("create", (f) => {
					if (this.suppressEvents) return;      // 우리가 받아 쓴 파일은 무시
					if (!f || !f.path || f.children) return;  // 폴더 제외
					this.pendingUploads.add(f.path);
					this.scheduleAutoUpload();
				}),
			);
			this.maybeAutoDownload();
		});
	}

	onunload() {
		if (this.uploadTimer) clearTimeout(this.uploadTimer);
	}

	// ---------------------------------------------------------------- 자동화

	/** 열 때 한 번. 너무 자주 돌지 않게 간격을 둔다. */
	async maybeAutoDownload() {
		const s = this.settings;
		if (!s.autoDownloadOnOpen) return;
		if (!s.refreshToken || !s.rootFolderId) return;   // 설정 전이면 조용히 넘어간다
		const gap = (s.autoDownloadGapMin || 0) * 60000;
		if (Date.now() - (s.lastAutoDownload || 0) < gap) return;

		s.lastAutoDownload = Date.now();
		await this.saveSettings();
		await this.run(() => this.download(false, true));
	}

	/** 새 노트가 생기면 잠잠해진 뒤에 올린다. 타이핑 중에 끼어들지 않게. */
	scheduleAutoUpload() {
		if (!this.settings.autoUploadNew) return;
		if (this.uploadTimer) clearTimeout(this.uploadTimer);
		const delay = Math.max(5, this.settings.autoUploadDelaySec || 60) * 1000;
		this.uploadTimer = setTimeout(() => {
			this.uploadTimer = null;
			this.pendingUploads.clear();
			this.run(() => this.upload(false, true));
		}, delay);
	}

	async syncNow() {
		await this.download(false, true);
		await this.upload(false, true);
		new Notice("✅ 동기화 완료");
	}

	// ---------------------------------------------------------------- 노트 생성

	/**
	 * 템플릿으로 노트를 만든다. **이미 있으면 덮어쓰지 않고 그 파일을 연다.**
	 * 월간 일지처럼 이미 존재하는 파일을 날려먹지 않기 위해서다.
	 */
	async createNote(type, value) {
		const folder = fillTemplate(type.folder, value);
		const name = safeName(fillTemplate(type.filename, value));
		const path = `${folder}/${name}.md`;

		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing) {
			await this.app.workspace.getLeaf(false).openFile(existing);
			new Notice("이미 있어서 그 파일을 열었다:\n" + path, 7000);
			return;
		}

		const tpl = this.app.vault.getAbstractFileByPath(type.template);
		if (!tpl) throw new Error(`템플릿이 없다: ${type.template}\n(90_Templates 를 받았는지 확인)`);
		const body = fillTemplate(await this.app.vault.read(tpl), value);

		await this.ensureFolder(path);
		const file = await this.app.vault.create(path, body);
		await this.app.workspace.getLeaf(false).openFile(file);
		new Notice("✅ 만들었다: " + path, 5000);
		// create 이벤트가 걸려 있어 잠시 뒤 자동 업로드 대상이 된다
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

	/** 자동 실행 때는 진행 상황을 띄우지 않는다. 결과만 알린다. */
	progress(quiet, msg) {
		if (quiet) return { setMessage() {}, hide() {} };
		return new Notice(msg, 0);
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
	 * 폴더는 따로 모은다. 업로드할 때 부모 ID 를 찾는 데 쓴다.
	 */
	async buildTree(token, onProgress) {
		const excludes = this.excludeList();
		const files = new Map();
		const folders = new Map(); // 경로 -> 폴더 ID
		let calls = 0;

		const walk = async (folderId, relPath) => {
			calls++;
			if (onProgress && calls % 5 === 0) onProgress(files.size, calls);
			for (const c of await this.listChildren(token, folderId)) {
				// 제외는 최상위에서만 판단한다
				if (!relPath && excludes.includes(c.name)) continue;
				const path = relPath ? relPath + "/" + c.name : c.name;
				if (c.mimeType === FOLDER_MIME) {
					folders.set(path, c.id);
					await walk(c.id, path);
				} else {
					files.set(path, c);
				}
			}
		};

		await walk(this.settings.rootFolderId.trim(), "");
		return { files, folders, calls };
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
	 * preview 면 아무것도 쓰지 않고 계획만 보여준다.
	 * quiet 면 (자동 실행) 바뀐 게 있을 때만 알린다.
	 */
	async download(preview, quiet) {
		const notice = this.progress(quiet, preview ? "미리보기 계산 중…" : "다운로드 준비 중…");
		const token = await this.getAccessToken();
		const adapter = this.app.vault.adapter;
		const { files } = await this.buildTree(token, (n) =>
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
			if (!quiet) new Notice("받을 파일이 없다. 이미 최신이다.");
			return;
		}

		let done = 0, failed = 0;
		const errors = [];
		// 우리가 쓰는 파일이 create 이벤트로 되돌아와 업로드 대기열에 들어가지 않게 막는다
		this.suppressEvents = true;
		try {
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
		} finally {
			// 이벤트가 늦게 도착할 수 있어 잠시 뒤에 푼다
			setTimeout(() => { this.suppressEvents = false; }, 3000);
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

	// ---------------------------------------------------------------- 2단계

	/** vault 의 로컬 파일. `.obsidian` 은 getFiles 가 애초에 주지 않는다. */
	localTextFiles() {
		const excludes = this.excludeList();
		const TEXT = ["md", "txt", "canvas", "csv", "json"];
		const out = [];
		const skippedBinary = [];
		for (const f of this.app.vault.getFiles()) {
			const top = f.path.includes("/") ? f.path.split("/")[0] : "";
			if (top && excludes.includes(top)) continue;
			if (TEXT.includes((f.extension || "").toLowerCase())) out.push(f);
			else skippedBinary.push(f.path);
		}
		return { files: out, skippedBinary };
	}

	/** Drive 에 폴더가 없으면 만든다. 경로를 위에서부터 훑으며 ID 를 돌려준다. */
	async ensureDriveFolder(token, folders, dirPath) {
		if (!dirPath) return this.settings.rootFolderId.trim();
		if (folders.has(dirPath)) return folders.get(dirPath);

		const parts = dirPath.split("/");
		let cur = "";
		let parentId = this.settings.rootFolderId.trim();
		for (const p of parts) {
			cur = cur ? cur + "/" + p : p;
			if (folders.has(cur)) {
				parentId = folders.get(cur);
				continue;
			}
			const res = await requestUrl({
				url: API + "?supportsAllDrives=true",
				method: "POST",
				headers: { Authorization: "Bearer " + token },
				contentType: "application/json",
				body: JSON.stringify({ name: p, mimeType: FOLDER_MIME, parents: [parentId] }),
				throw: false,
			});
			if (res.status !== 200 && res.status !== 201) {
				throw new Error(`폴더 생성 실패 ${cur}: ${res.status} ${(res.text || "").slice(0, 120)}`);
			}
			parentId = res.json.id;
			folders.set(cur, parentId);
		}
		return parentId;
	}

	/** 새 파일을 Drive 에 만든다. **기존 파일은 절대 건드리지 않는다.** */
	async createOnDrive(token, parentId, name, content) {
		const b = "----gdvs" + Date.now();
		const meta = JSON.stringify({ name, parents: [parentId] });
		const body =
			`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
			`--${b}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n${content}\r\n` +
			`--${b}--\r\n`;

		const res = await requestUrl({
			url: "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true",
			method: "POST",
			headers: { Authorization: "Bearer " + token },
			contentType: `multipart/related; boundary=${b}`,
			body,
			throw: false,
		});
		if (res.status !== 200 && res.status !== 201) {
			throw new Error(`${res.status} ${(res.text || "").slice(0, 160)}`);
		}
		return res.json.id;
	}

	/**
	 * 로컬 -> Drive. **Drive 에 없는 파일만 올린다.**
	 * 기존 파일 수정도, 삭제도 하지 않는다. drive.file 권한이라 애초에 불가능하다.
	 */
	async upload(preview, quiet) {
		const notice = this.progress(quiet, preview ? "미리보기 계산 중…" : "업로드 준비 중…");
		const token = await this.getAccessToken();
		const { files: driveFiles, folders } = await this.buildTree(token, (n) =>
			notice.setMessage(`Drive 목록 수집 중… ${n}개`),
		);
		const { files: locals, skippedBinary } = this.localTextFiles();

		const isNew = locals.filter((f) => !driveFiles.has(f.path));
		const exists = locals.length - isNew.length;

		if (preview) {
			notice.hide();
			const sample = isNew.slice(0, 8).map((f) => "   " + f.path).join("\n");
			new Notice(
				[
					"📋 업로드 미리보기 (아무것도 올리지 않았다)",
					"",
					`새로 올릴 파일   ${isNew.length}개`,
					isNew.length ? sample : "   (없음)",
					isNew.length > 8 ? `   … 외 ${isNew.length - 8}개` : "",
					"",
					`이미 Drive 에 있음 ${exists}개 — 건드리지 않는다`,
					skippedBinary.length ? `텍스트 아님 ${skippedBinary.length}개 — 올리지 않는다` : "",
					"",
					"실행하려면 «Drive 업로드 — 실행»",
				].filter(Boolean).join("\n"),
				30000,
			);
			return;
		}

		if (!isNew.length) {
			notice.hide();
			if (!quiet) new Notice("올릴 새 파일이 없다.");
			return;
		}

		let done = 0, failed = 0;
		const errors = [];
		for (const f of isNew) {
			try {
				const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
				const parentId = await this.ensureDriveFolder(token, folders, dir);
				const content = await this.app.vault.read(f);
				await this.createOnDrive(token, parentId, f.name, content);
				done++;
			} catch (e) {
				failed++;
				if (errors.length < 3) errors.push(`${f.path}: ${e.message}`);
			}
			notice.setMessage(`업로드 ${done + failed}/${isNew.length}…`);
		}

		notice.hide();
		new Notice(
			[
				failed ? "⚠️ 업로드 완료 (일부 실패)" : "✅ 업로드 완료",
				`올림 ${done}개 · 실패 ${failed}개`,
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

		containerEl.createEl("h3", { text: "자동화" });
		containerEl.createEl("p", {
			text: "자동으로 돌아도 하는 일은 수동과 같다 — 받기는 로컬에만 쓰고 로컬이 최신이면 건너뛰며, 올리기는 새 파일만 만든다. 기존 파일을 고치거나 지우는 경로가 없다.",
		});

		const toggle = (name, desc, key) =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addToggle((t) =>
					t.setValue(!!this.plugin.settings[key]).onChange(async (v) => {
						this.plugin.settings[key] = v;
						await this.plugin.saveSettings();
					}),
				);

		const number = (name, desc, key, min) =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addText((t) =>
					t.setValue(String(this.plugin.settings[key])).onChange(async (v) => {
						const n = parseInt(v, 10);
						if (!isNaN(n) && n >= min) {
							this.plugin.settings[key] = n;
							await this.plugin.saveSettings();
						}
					}),
				);

		toggle("열 때 자동으로 받기", "vault 를 열면 Drive 의 새 파일을 내려받는다", "autoDownloadOnOpen");
		number("자동 받기 최소 간격 (분)", "이 시간 안에 이미 받았으면 건너뛴다", "autoDownloadGapMin", 0);
		toggle("새 노트 자동 올리기", "노트를 만들면 잠시 뒤 Drive 에 올린다", "autoUploadNew");
		number("올리기 대기 시간 (초)", "새 노트를 만들고 이만큼 조용하면 올린다", "autoUploadDelaySec", 5);
	}
}

module.exports = GDriveVaultSync;
