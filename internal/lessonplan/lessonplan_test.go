package lessonplan

import (
	"strings"
	"testing"
)

func TestReshapeZipsOutlineAndNotes(t *testing.T) {
	outline := []byte(`{"source":"generated-deck","slides":[{"order":1,"type":"COVER","title":"导数"},{"order":2,"type":"CONTENT","title":"差商"}]}`)
	notes := []byte(`[{"page":1,"note":"第一页讲稿"},{"page":2,"note":"第二页讲稿"}]`)
	p, md, err := Reshape("第 3 章 导数", outline, notes)
	if err != nil {
		t.Fatal(err)
	}
	if p.Title != "第 3 章 导数" || len(p.Columns) != 2 {
		t.Fatalf("%+v", p)
	}
	if p.Columns[0].Title != "导数" || p.Columns[0].Type != "COVER" || p.Columns[0].Teach != "第一页讲稿" {
		t.Fatalf("col0 = %+v", p.Columns[0])
	}
	if p.Columns[1].Title != "差商" || p.Columns[1].Teach != "第二页讲稿" {
		t.Fatalf("col1 = %+v", p.Columns[1])
	}
	if !strings.Contains(md, "# 第 3 章 导数") || !strings.Contains(md, "讲授要点：第一页讲稿") {
		t.Fatalf("markdown = %s", md)
	}
}

func TestReshapeNotesOnly(t *testing.T) {
	p, _, err := Reshape("导数", nil, []byte(`{"pages":[{"page":1,"notes":"差商的极限"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Columns) != 1 || p.Columns[0].Teach != "差商的极限" || p.Columns[0].Title != "第 1 页" {
		t.Fatalf("%+v", p)
	}
}

func TestReshapeRejectsEmptyNotes(t *testing.T) {
	if _, _, err := Reshape("导数", nil, []byte(`[]`)); err != ErrEmpty {
		t.Fatalf("err=%v, want ErrEmpty", err)
	}
	if _, _, err := Reshape("导数", nil, nil); err != ErrEmpty {
		t.Fatalf("err=%v, want ErrEmpty", err)
	}
}
