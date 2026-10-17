import { describe, expect, it } from "vitest";
import { canRestart, cleanVersion, errorText, releaseUrl, repoFrom, updateMode, type UpdateEnv } from "./updater-core";

const env = (p: Partial<UpdateEnv>): UpdateEnv => ({ platform: "win32", packaged: true, macSigned: false, ...p });

describe("updateMode", () => {
  it("installs on the Windows installer, only tells on the portable exe", () => {
    expect(updateMode(env({}))).toBe("install");
    expect(updateMode(env({ portableDir: "C:\\Apps" }))).toBe("notify");
  });
  it("mac installs only when signed", () => {
    expect(updateMode(env({ platform: "darwin" }))).toBe("notify");
    expect(updateMode(env({ platform: "darwin", macSigned: true }))).toBe("install");
  });
  it("linux installs inside an AppImage", () => {
    expect(updateMode(env({ platform: "linux", appImage: "/x/OpenTake.AppImage" }))).toBe("install");
    expect(updateMode(env({ platform: "linux" }))).toBe("notify");
  });
  it("is off in dev unless a version is faked", () => {
    expect(updateMode(env({ packaged: false }))).toBe("off");
    expect(updateMode(env({ packaged: false, fakeVersion: "0.9.0" }))).toBe("install");
  });
});

describe("repoFrom", () => {
  it("reads every repository form npm accepts", () => {
    expect(repoFrom({ type: "git", url: "https://github.com/Svrubio7/Opentake.git" })).toEqual({ owner: "Svrubio7", repo: "Opentake" });
    expect(repoFrom("git+ssh://git@github.com:me/thing.git")).toEqual({ owner: "me", repo: "thing" });
    expect(repoFrom("github:me/thing")).toEqual({ owner: "me", repo: "thing" });
    expect(repoFrom("me/thing")).toEqual({ owner: "me", repo: "thing" });
    expect(repoFrom(undefined)).toBeNull();
    expect(repoFrom({ url: "https://gitlab.com/a" })).toBeNull();
  });
});

describe("helpers", () => {
  it("links the tagged release", () => {
    expect(releaseUrl({ owner: "a", repo: "b" }, "1.1.0")).toBe("https://github.com/a/b/releases/tag/v1.1.0");
    expect(releaseUrl({ owner: "a", repo: "b" }, "v1.1.0")).toBe("https://github.com/a/b/releases/tag/v1.1.0");
    expect(releaseUrl({ owner: "a", repo: "b" })).toBe("https://github.com/a/b/releases/latest");
  });
  it("accepts only real versions for the dev override", () => {
    expect(cleanVersion("0.9.0")).toBe("0.9.0");
    expect(cleanVersion("v1.2.3-beta.1")).toBe("1.2.3-beta.1");
    expect(cleanVersion("latest")).toBeNull();
    expect(cleanVersion(undefined)).toBeNull();
  });
  it("never restarts during a take, an export, a notify build or a faked version", () => {
    const ok = { ready: true, busy: false, mode: "install" as const, fake: false };
    expect(canRestart(ok)).toBe(true);
    expect(canRestart({ ...ok, busy: true })).toBe(false);
    expect(canRestart({ ...ok, ready: false })).toBe(false);
    expect(canRestart({ ...ok, mode: "notify" })).toBe(false);
    expect(canRestart({ ...ok, fake: true })).toBe(false);
  });
  it("says network failures plainly", () => {
    expect(errorText(new Error("getaddrinfo ENOTFOUND github.com"))).toMatch(/connection/);
    expect(errorText(new Error("HttpError: 404"))).toMatch(/No published/);
    expect(errorText("weird")).toBe("The update check failed.");
  });
});
