package lessonplan

import (
	"strings"
	"testing"

	"codelphi/internal/extract"
)

func TestReshapeTurnsNotesIntoLessonPlan(t *testing.T) {
	outline := []byte(`{"source":"generated-deck","slides":[{"order":1,"type":"COVER","title":"导数"},{"order":2,"type":"CONTENT","title":"差商"}]}`)
	notes := []byte(`[{"page":1,"note":"第一页讲稿"},{"page":2,"note":"第二页讲稿"}]`)
	p, md, err := Reshape("第 3 章 导数", outline, notes)
	if err != nil {
		t.Fatal(err)
	}
	if p.Title != "第 3 章 导数" {
		t.Fatalf("title = %q", p.Title)
	}
	if len(p.Goals) == 0 || p.Goals[0] != "差商" {
		t.Fatalf("goals = %v, want CONTENT titles as 教学目标", p.Goals)
	}
	if len(p.Focus) != 1 || p.Focus[0] != "差商" {
		t.Fatalf("focus = %v, want only the core 新授 title", p.Focus)
	}
	if len(p.Hard) != 0 {
		t.Fatalf("hard = %v, short notes without 难点 cues should stay empty", p.Hard)
	}
	if !contains(p.Methods, "讲授法") {
		t.Fatalf("methods = %v, want 讲授法", p.Methods)
	}
	if len(p.Process) != 2 {
		t.Fatalf("process = %+v, want 导入+新授", p.Process)
	}
	if p.Process[0].Name != "导入" || p.Process[0].Teacher != "第一页讲稿" || p.Process[0].Title != "导数" {
		t.Fatalf("导入 = %+v", p.Process[0])
	}
	if p.Process[1].Name != "新授" || p.Process[1].Teacher != "第二页讲稿" || p.Process[1].Title != "差商" {
		t.Fatalf("新授 = %+v", p.Process[1])
	}
	if strings.TrimSpace(p.Process[0].Student) == "" || strings.TrimSpace(p.Process[0].Intent) == "" {
		t.Fatalf("教案环节缺学生活动/设计意图: %+v", p.Process[0])
	}
	if !strings.Contains(md, "# 第 3 章 导数 教案") {
		t.Fatalf("markdown title = %s", md)
	}
	if !strings.Contains(md, "## 一、教学目标") || !strings.Contains(md, "## 四、教学过程") {
		t.Fatalf("markdown missing 教案栏目: %s", md)
	}
	if !strings.Contains(md, "### （一）导入") || !strings.Contains(md, "**教师活动：** 第一页讲稿") {
		t.Fatalf("markdown process = %s", md)
	}
	if strings.Contains(md, "讲授要点：") {
		t.Fatalf("markdown still looks like 讲稿: %s", md)
	}
}

func TestReshapeMapsBackCoverToSummary(t *testing.T) {
	outline := []byte(`{"slides":[
		{"order":1,"type":"COVER","title":"导数"},
		{"order":2,"type":"CONTENT","title":"差商"},
		{"order":3,"type":"BACK_COVER","title":"小结"}
	]}`)
	notes := []byte(`[{"notes":"开场"},{"notes":"展开差商"},{"notes":"回顾本课"}]`)
	p, _, err := Reshape("导数", outline, notes)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Process) != 3 {
		t.Fatalf("process = %+v", p.Process)
	}
	if p.Process[2].Name != "小结" || p.Process[2].Teacher != "回顾本课" {
		t.Fatalf("小结 = %+v", p.Process[2])
	}
}

func TestReshapeGroupsNewTeachingPages(t *testing.T) {
	outline := []byte(`{"slides":[
		{"order":1,"type":"COVER","title":"导数"},
		{"order":2,"type":"CONTENT","title":"差商"},
		{"order":3,"type":"CONTENT","title":"极限"},
		{"order":4,"type":"BACK_COVER","title":"小结"}
	]}`)
	notes := []byte(`[{"notes":"开场"},{"notes":"讲差商"},{"notes":"讲极限"},{"notes":"回顾本课"}]`)
	p, _, err := Reshape("导数", outline, notes)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Process) != 3 {
		t.Fatalf("process = %+v, want 导入+新授+小结", p.Process)
	}
	if p.Process[1].Name != "新授" || p.Process[1].Pages != "2–3" {
		t.Fatalf("新授 = %+v", p.Process[1])
	}
	if !strings.Contains(p.Process[1].Teacher, "讲差商") || !strings.Contains(p.Process[1].Teacher, "讲极限") {
		t.Fatalf("新授教师活动 = %q", p.Process[1].Teacher)
	}
	if !strings.Contains(p.Process[1].Teacher, "【差商】") || !strings.Contains(p.Process[1].Teacher, "【极限】") {
		t.Fatalf("新授应分步骤标题: %q", p.Process[1].Teacher)
	}
}

func TestEmphasisDoesNotDumpChapterTitles(t *testing.T) {
	outline := []byte(`{"slides":[
		{"order":1,"type":"COVER","title":"导数"},
		{"order":2,"type":"CONTENT","title":"背景"},
		{"order":3,"type":"CONTENT","title":"差商的定义"},
		{"order":4,"type":"CONTENT","title":"几何意义"},
		{"order":5,"type":"CONTENT","title":"计算举例"},
		{"order":6,"type":"CONTENT","title":"课堂练习"},
		{"order":7,"type":"BACK_COVER","title":"小结"}
	]}`)
	notes := []byte(`[
		{"notes":"开场"},
		{"notes":"先回顾极限。注意昨天作业。"},
		{"notes":"差商定义为 Δy/Δx，这是本课必须掌握的核心概念。"},
		{"notes":"几何上是割线斜率。"},
		{"notes":"看两个例子。"},
		{"notes":"请同学做练习。学生容易把差商和导数弄混。"},
		{"notes":"回顾本课"}
	]`)
	p, md, err := Reshape("第 3 章 导数", outline, notes)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Focus) > 2 {
		t.Fatalf("focus = %v, 重点 must not dump the chapter", p.Focus)
	}
	if !contains(p.Focus, "差商的定义") {
		t.Fatalf("focus = %v, want 差商的定义", p.Focus)
	}
	if contains(p.Focus, "背景") || contains(p.Focus, "计算举例") || contains(p.Focus, "课堂练习") {
		t.Fatalf("focus listed filler pages: %v", p.Focus)
	}
	if len(p.Hard) == 0 || !strings.Contains(strings.Join(p.Hard, " "), "差商") {
		t.Fatalf("hard = %v, want 易混 cue from 练习页", p.Hard)
	}
	if len(p.Hard) > 2 {
		t.Fatalf("hard = %v, 难点 must stay sparse", p.Hard)
	}
	if sameSet(p.Focus, p.Goals) || sameSet(p.Hard, p.Goals) {
		t.Fatalf("重难点 copied 教学目标: focus=%v hard=%v goals=%v", p.Focus, p.Hard, p.Goals)
	}
	if !strings.Contains(md, "**重点**") || !strings.Contains(md, "**难点**") {
		t.Fatalf("markdown 重难点 = %s", md)
	}
	if strings.Contains(strings.Join(p.Hard, "\n"), "注意昨天") || strings.Contains(strings.Join(p.Focus, "\n"), "注意昨天") {
		t.Fatalf("bare 注意 must not become 重难点: focus=%v hard=%v", p.Focus, p.Hard)
	}
}

func TestReshapeNotesOnlyStillHasStages(t *testing.T) {
	p, _, err := Reshape("导数", nil, []byte(`{"pages":[{"page":1,"notes":"差商的极限"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Process) != 1 || p.Process[0].Name != "导入" || p.Process[0].Teacher != "差商的极限" {
		t.Fatalf("%+v", p)
	}
	if p.Title != "导数" {
		t.Fatalf("title = %q", p.Title)
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

func TestOverlayAppliesLLMOutcomes(t *testing.T) {
	p, _, err := Reshape("第 3 章 导数",
		[]byte(`{"slides":[{"order":1,"type":"COVER","title":"导数"},{"order":2,"type":"CONTENT","title":"差商"}]}`),
		[]byte(`[{"note":"开场"},{"note":"讲差商"}]`))
	if err != nil {
		t.Fatal(err)
	}
	raw := []byte(`{"教学目标":["能陈述差商定义，达到会计算简单差商的水平"],"教学重点":["差商作为平均变化率"],"教学难点":["趋近过程易与瞬时变化率混淆"]}`)
	if err := Overlay(p, raw); err != nil {
		t.Fatal(err)
	}
	if len(p.Goals) != 1 || p.Goals[0] != "能陈述差商定义，达到会计算简单差商的水平" {
		t.Fatalf("goals = %v", p.Goals)
	}
	if len(p.Goals) == 1 && p.Goals[0] == "差商" {
		t.Fatalf("教学目标 must not remain a slide title: %v", p.Goals)
	}
	if len(p.Focus) != 1 || p.Focus[0] != "差商作为平均变化率" {
		t.Fatalf("focus = %v", p.Focus)
	}
	if len(p.Hard) != 1 || !strings.Contains(p.Hard[0], "趋近") {
		t.Fatalf("hard = %v", p.Hard)
	}
}

func TestFromTeachingWritesProcessAndScript(t *testing.T) {
	raw := []byte(`{"教学目标":["能陈述差商定义，达到会计算简单差商的水平"],"教学重点":["差商作为平均变化率"],"教学难点":["趋近过程易与瞬时变化率混淆"],"教学过程":[{"环节":"导入","教师活动":"从课文实例引入"},{"环节":"新授","教师活动":"讲清差商"}],"讲授稿":"从课文里的平均变化率讲起"}`)
	p, err := FromTeaching("第 3 章 导数", raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Process) != 2 || p.Process[0].Teacher != "从课文实例引入" {
		t.Fatalf("process = %+v", p.Process)
	}
	if p.Script != "从课文里的平均变化率讲起" {
		t.Fatalf("script = %q", p.Script)
	}
	md := Markdown(p)
	if !strings.Contains(md, "## 五、教学讲稿") || !strings.Contains(md, "从课文里的平均变化率讲起") {
		t.Fatalf("markdown missing 教学讲稿: %s", md)
	}
}

func TestFromTeachingRejectsNotesShapedJSON(t *testing.T) {
	if _, err := FromTeaching("导数", []byte(`{"教学目标":["能做题"],"教学重点":["x"],"教学难点":[]}`)); err == nil {
		t.Fatal("want error when 教学过程/讲授稿 missing")
	}
}

func TestOverlayRejectsEmptyGoals(t *testing.T) {
	p := &Plan{Title: "导数"}
	if err := Overlay(p, []byte(`{"教学目标":[],"教学重点":["x"],"教学难点":[]}`)); err == nil {
		t.Fatal("want error")
	}
}

func TestWriteDocxIsLessonPlanNotScript(t *testing.T) {
	p := &Plan{
		Title:    "第 3 章 导数",
		Goals:    []string{"差商"},
		Focus:    []string{"差商"},
		Hard:     []string{"从差商过渡到极限"},
		Methods:  []string{"讲授法", "演示法"},
		Process: []Stage{
			{Name: "导入", Title: "导数", Pages: "1", Teacher: "第一页讲稿", Student: "明确课题", Intent: "集中注意"},
			{Name: "新授", Title: "差商", Pages: "2", Teacher: "第二页讲稿", Student: "记录要点", Intent: "展开讲解"},
		},
		Script: "从课文讲起",
	}
	raw, err := WriteDocx(p)
	if err != nil {
		t.Fatal(err)
	}
	text, err := extract.Text("docx", raw)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"第 3 章 导数 教案", "教学目标", "教学过程", "导入", "教师活动", "第一页讲稿", "教学讲稿", "从课文讲起"} {
		if !strings.Contains(text, want) {
			t.Fatalf("docx text missing %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "讲述稿") || strings.Contains(text, "讲授要点") {
		t.Fatalf("docx still looks like 讲稿: %s", text)
	}
}

func contains(ss []string, want string) bool {
	for _, s := range ss {
		if s == want {
			return true
		}
	}
	return false
}

func sameSet(a, b []string) bool {
	if len(a) == 0 || len(b) == 0 || len(a) != len(b) {
		return false
	}
	seen := map[string]int{}
	for _, s := range a {
		seen[s]++
	}
	for _, s := range b {
		seen[s]--
		if seen[s] < 0 {
			return false
		}
	}
	return true
}
