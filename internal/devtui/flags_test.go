package devtui

import "testing"

func TestParseFlagsDefaults(t *testing.T) {
	f, err := ParseFlags(nil)
	if err != nil {
		t.Fatal(err)
	}
	if f.Base != "http://127.0.0.1:8080" {
		t.Fatalf("base = %q", f.Base)
	}
	if f.Token != "dev" {
		t.Fatalf("token = %q", f.Token)
	}
	if f.OrgID != SeedOrgID {
		t.Fatalf("org = %q", f.OrgID)
	}
}

func TestParseFlagsOneShot(t *testing.T) {
	f, err := ParseFlags([]string{
		"-textbook", "课文.md",
		"-title", "第 3 章 导数",
		"-until", "ready",
		"-base", "http://127.0.0.1:18080",
	})
	if err != nil {
		t.Fatal(err)
	}
	if f.Textbook != "课文.md" || f.Title != "第 3 章 导数" || f.Until != "ready" {
		t.Fatalf("%+v", f)
	}
	if f.Base != "http://127.0.0.1:18080" {
		t.Fatalf("base = %q", f.Base)
	}
}

func TestParseFlagsRebuild(t *testing.T) {
	f, err := ParseFlags([]string{
		"-package", "01PKG",
		"-rebuild-kind", "ppt",
		"-critique", "封面改导数定义",
	})
	if err != nil {
		t.Fatal(err)
	}
	if f.Package != "01PKG" || f.RebuildKind != "ppt" || f.Critique != "封面改导数定义" {
		t.Fatalf("%+v", f)
	}
}

func TestIsTerminal(t *testing.T) {
	if !IsTerminal("ready", "") || !IsTerminal("partial", "") || !IsTerminal("failed", "") {
		t.Fatal("package terminal")
	}
	if !IsTerminal("building", "failed") {
		t.Fatal("lesson failed is terminal")
	}
	if IsTerminal("building", "running") {
		t.Fatal("still running")
	}
	if !NeedsConfirm("awaiting_confirm") {
		t.Fatal("gate")
	}
	if NeedsConfirm("running") {
		t.Fatal("not a gate")
	}
}

func TestKindFromFilename(t *testing.T) {
	kind, ok := KindFromFilename("课文.md")
	if !ok || kind != "text" {
		t.Fatalf("md = %q %v", kind, ok)
	}
	if _, ok := KindFromFilename("x.pptx"); ok {
		t.Fatal("pptx should be rejected")
	}
}
