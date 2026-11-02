/*
 * GDrive Vault Sync — 0단계 (연결 확인 전용)
 *
 * 설계 원칙 — 2026-10 중복 사태에서 얻은 교훈을 구조로 박아 둔다.
 *   1. 상태 파일을 만들지 않는다.
 *      changesToken·lastSyncedAt 같은 기기별 값을 저장하지 않고 매번 Drive 를 직접 조회한다.
 *      기기 사이에 덮어쓸 상태가 없으므로 다기기에서 어긋날 수가 없다.
 *   2. `.obsidian/` 을 절대 건드리지 않는다.
 *      설정 폴더 동기화가 이번 사고의 뿌리였다.
 *   3. 삭제하지 않는다. 0단계는 쓰기 자체를 하지 않는다.
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

/** 항상 제외 — 설정으로도 풀 수 없다. 1번 원칙. */
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

		this.addCommand({
			id: "check-connection",
			name: "Drive 연결 확인",
			callback: () => this.run(() => this.checkConnection()),
		});
		this.addCommand({
			id: "scan-drive",
			name: "Drive 전체 스캔 (읽기만)",
			callback: () => this.run(() => this.scanDrive()),
		});
		this.addRibbonIcon("cloud", "Drive 연결 확인", () =>
			this.run(() => this.checkConnection()),
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
		try {
			await fn();
		} catch (e) {
			console.error(e);
			new Notice("❌ " + (e && e.message ? e.message : String(e)), 15000);
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
			const q = `'${folderId}' in parents and trashed = false`;
			const params = [
				"q=" + encodeURIComponent(q),
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

	// ---------------------------------------------------------------- 명령

	async checkConnection() {
		new Notice("연결 확인 중…");
		const token = await this.getAccessToken();
		const children = await this.listChildren(token, this.settings.rootFolderId.trim());
		const dirs = children.filter((f) => f.mimeType === FOLDER_MIME);
		const files = children.length - dirs.length;

		const lines = [
			"✅ 연결 성공",
			`최상위 폴더 ${dirs.length}개 · 파일 ${files}개`,
			"",
			dirs.map((d) => "  " + d.name).join("\n"),
		];
		new Notice(lines.join("\n"), 15000);
		console.log("[gdrive-vault-sync] 최상위:", children.map((c) => c.name));
	}

	/** 재귀로 전부 훑는다. 읽기만 하고 아무것도 쓰지 않는다. */
	async scanDrive() {
		new Notice("전체 스캔 중… 시간이 걸린다");
		const token = await this.getAccessToken();
		const excludes = this.excludeList();
		const perTop = {};
		let total = 0,
			bytes = 0,
			calls = 0;

		const walk = async (folderId, topName, relPath) => {
			calls++;
			const children = await this.listChildren(token, folderId);
			for (const c of children) {
				const name = c.name;
				const path = relPath ? relPath + "/" + name : name;
				// 최상위에서만 제외 규칙을 적용한다
				if (!relPath && excludes.includes(name)) continue;
				if (c.mimeType === FOLDER_MIME) {
					await walk(c.id, topName || name, path);
				} else {
					const key = topName || "(루트)";
					perTop[key] = (perTop[key] || 0) + 1;
					total++;
					bytes += Number(c.size || 0);
				}
			}
		};

		await walk(this.settings.rootFolderId.trim(), null, "");

		const rows = Object.keys(perTop)
			.sort((a, b) => perTop[b] - perTop[a])
			.map((k) => `  ${k}: ${perTop[k]}`)
			.join("\n");
		const mb = (bytes / 1024 / 1024).toFixed(1);
		const msg = [
			"✅ 스캔 완료 (읽기만 함)",
			`파일 ${total}개 · ${mb} MB · API 호출 ${calls}회`,
			`제외: ${excludes.join(", ")}`,
			"",
			rows,
		].join("\n");
		new Notice(msg, 20000);
		console.log("[gdrive-vault-sync] 스캔:", { total, bytes, calls, perTop });
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
			text: "자격증명은 이 기기에만 저장된다. .obsidian 폴더는 동기화 대상이 아니므로 다른 기기로 넘어가지 않는다.",
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
		text("제외할 최상위 폴더", "쉼표로 구분. .obsidian 과 .trash 는 설정과 무관하게 항상 제외된다", "excludes", "_migration, _attachments");
	}
}

module.exports = GDriveVaultSync;
