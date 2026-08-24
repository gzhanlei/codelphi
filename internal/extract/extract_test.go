package extract

import (
	"archive/zip"
	"bytes"
	"testing"
)

func TestKindFromFilename(t *testing.T) {
	cases := []struct {
		name string
		kind string
		ok   bool
	}{
		{"课文.md", "text", true},
		{"note.TXT", "text", true},
		{"设计.docx", "docx", true},
		{"教材.PDF", "pdf", true},
		{"x.doc", "", false},
		{"pic.png", "", false},
	}
	for _, c := range cases {
		kind, ok := KindFromFilename(c.name)
		if kind != c.kind || ok != c.ok {
			t.Fatalf("%s: got %s %v", c.name, kind, ok)
		}
	}
}

func TestTextPlain(t *testing.T) {
	got, err := Text("text", []byte("  导数的定义  \n"))
	if err != nil || got != "导数的定义" {
		t.Fatalf("got %q err=%v", got, err)
	}
}

func TestTextDocx(t *testing.T) {
	xml := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>教学目标：理解导数</w:t></w:r></w:p></w:body></w:document>`
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create("word/document.xml")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte(xml)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	got, err := Text("docx", buf.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if got != "教学目标：理解导数" {
		t.Fatalf("got %q", got)
	}
}

func TestTextUnsupported(t *testing.T) {
	if _, err := Text("image", []byte("x")); err == nil {
		t.Fatal("want error")
	}
}
