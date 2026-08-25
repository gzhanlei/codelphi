package lessonplan

import (
	"strings"
	"testing"
)

func TestCheckDeckEmptyOutlineIsNotDrift(t *testing.T) {
	p := &Plan{Focus: []string{"差商作为平均变化率"}, Process: []Stage{{Name: "新授", Teacher: "展开"}}}
	if issues := CheckDeck(p, nil, nil); len(issues) != 0 {
		t.Fatalf("issues = %+v, empty outline means 课件尚未生成", issues)
	}
}

func TestCheckDeckOKWhenTitlesCoverFocus(t *testing.T) {
	p := &Plan{
		Focus:   []string{"差商作为平均变化率"},
		Process: []Stage{{Name: "导入", Teacher: "引入"}, {Name: "新授", Teacher: "展开"}},
	}
	outline := []byte(`{"slides":[{"order":1,"type":"COVER","title":"导数"},{"order":2,"type":"CONTENT","title":"差商"}]}`)
	if issues := CheckDeck(p, outline, nil); len(issues) != 0 {
		t.Fatalf("issues = %+v, want none", issues)
	}
}

func TestCheckDeckNotesCanCoverFocus(t *testing.T) {
	p := &Plan{
		Focus:   []string{"差商作为平均变化率"},
		Process: []Stage{{Name: "新授", Teacher: "展开"}},
	}
	outline := []byte(`{"slides":[{"order":1,"type":"CONTENT","title":"从割线到切线"}]}`)
	if issues := CheckDeck(p, outline, nil); len(issues) == 0 {
		t.Fatal("title-only must not cover 差商")
	}
	notes := []byte(`[{"notes":"本页讲差商作为平均变化率"}]`)
	if issues := CheckDeck(p, outline, notes); len(issues) != 0 {
		t.Fatalf("notes should cover focus: %+v", issues)
	}
}

func TestCheckDeckReportsUncoveredFocus(t *testing.T) {
	p := &Plan{
		Focus:   []string{"差商作为平均变化率"},
		Process: []Stage{{Name: "导入", Teacher: "引入"}, {Name: "新授", Teacher: "展开"}},
	}
	outline := []byte(`{"slides":[{"order":1,"type":"COVER","title":"封面"},{"order":2,"type":"CONTENT","title":"目录"}]}`)
	issues := CheckDeck(p, outline, nil)
	if len(issues) == 0 {
		t.Fatal("want uncovered_focus")
	}
	if issues[0].Code != "uncovered_focus" {
		t.Fatalf("issues = %+v", issues)
	}
	got := Critique(issues)
	if !strings.Contains(got, "课件与教案对不上") || !strings.Contains(got, "差商作为平均变化率") {
		t.Fatalf("critique = %q", got)
	}
	if Critique(nil) != "" {
		t.Fatal("empty issues must not critique")
	}
}
