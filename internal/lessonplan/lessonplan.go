// Package lessonplan 从课文写教案（教学目标 / 重难点 / 教学过程 / 教学讲稿）。
// 课件大纲只用来对照做片是否跑偏，不是教案内容来源。
package lessonplan

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

var ErrEmpty = errors.New("lessonplan: notes empty")

// Plan 是课时教案。栏目是教学目标 / 重难点 / 方法 / 教学过程 / 教学讲稿。
type Plan struct {
	Title   string   `json:"课题"`
	Goals   []string `json:"教学目标"`
	Focus   []string `json:"教学重点"`
	Hard    []string `json:"教学难点"`
	Methods []string `json:"教学方法"`
	Process []Stage  `json:"教学过程"`
	Script  string   `json:"讲授稿,omitempty"`
	Drift   []string `json:"课件对照,omitempty"`
}

// Stage 是教学过程中的一个环节。
type Stage struct {
	Name    string `json:"环节"`
	Pages   string `json:"对应页,omitempty"`
	Title   string `json:"标题,omitempty"`
	Teacher string `json:"教师活动"`
	Student string `json:"学生活动,omitempty"`
	Intent  string `json:"设计意图,omitempty"`
}

type slide struct {
	Order   int    `json:"order"`
	Type    string `json:"type"`
	Title   string `json:"title"`
	Chapter string `json:"chapter"`
}

type page struct {
	Order int
	Type  string
	Title string
	Teach string
}

var (
	reStudentCue = regexp.MustCompile(`(?:请|让)?(?:同学|学生).{0,24}(?:思考|讨论|回答|练习|计算|朗读|观察)`)
	reSummary    = regexp.MustCompile(`小结|总结|谢谢|作业|复习|回顾`)
	reFiller     = regexp.MustCompile(`举例|案例|练习|作业|引入|导入|背景|目录|封面|谢谢`)
	reFocusCue   = regexp.MustCompile(`必须掌握|核心概念|重点是|定义为|的定义|公式|定理|定律|原理|本质`)
	reHardCue    = regexp.MustCompile(`难点|难在|难以|难于|易错|易混|容易混淆|容易弄错|学生容易|容易误`)
)

// Reshape 用大纲页类型把讲稿 notes 收成教案栏目（导入 / 新授 / 小结），不是逐页复述。
func Reshape(lessonTitle string, outline, notes []byte) (*Plan, string, error) {
	teaches, err := parseNotes(notes)
	if err != nil {
		return nil, "", err
	}
	slides := parseSlides(outline)
	n := len(teaches)
	if len(slides) > n {
		n = len(slides)
	}
	pages := make([]page, 0, n)
	for i := 0; i < n; i++ {
		pg := page{Order: i + 1, Type: "CONTENT", Title: fmt.Sprintf("第 %d 页", i+1)}
		if i < len(slides) {
			if slides[i].Order > 0 {
				pg.Order = slides[i].Order
			}
			pg.Type = strings.ToUpper(strings.TrimSpace(slides[i].Type))
			if t := strings.TrimSpace(slides[i].Title); t != "" {
				pg.Title = t
			} else if ch := strings.TrimSpace(slides[i].Chapter); ch != "" {
				pg.Title = ch
			}
		}
		if i < len(teaches) {
			pg.Teach = teaches[i]
		}
		pages = append(pages, pg)
	}
	if !hasTeach(pages) {
		return nil, "", ErrEmpty
	}
	title := strings.TrimSpace(lessonTitle)
	if title == "" {
		title = firstTitle(pages)
	}
	focus, hard := focusAndHard(pages)
	p := &Plan{
		Title:   title,
		Goals:   goals(pages),
		Focus:   focus,
		Hard:    hard,
		Methods: methods(slides),
		Process: stages(pages),
	}
	return p, renderMarkdown(p), nil
}

func hasTeach(pages []page) bool {
	for _, p := range pages {
		if strings.TrimSpace(p.Teach) != "" {
			return true
		}
	}
	return false
}

func firstTitle(pages []page) string {
	for _, p := range pages {
		if t := strings.TrimSpace(p.Title); t != "" {
			return t
		}
	}
	return "本课"
}

func goals(pages []page) []string {
	seen := map[string]bool{}
	var out []string
	for _, p := range pages {
		if classify(p, len(pages)) != "新授" {
			continue
		}
		t := strings.TrimSpace(p.Title)
		if t == "" || strings.HasPrefix(t, "第 ") || seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
	}
	return out
}

func focusAndHard(pages []page) (focus, hard []string) {
	var cands []page
	for _, p := range pages {
		if classify(p, len(pages)) != "新授" {
			continue
		}
		t := strings.TrimSpace(p.Title)
		if t == "" || strings.HasPrefix(t, "第 ") {
			continue
		}
		cands = append(cands, p)
	}
	for _, p := range cands {
		if reason := hardReason(p); reason != "" {
			label := strings.TrimSpace(p.Title)
			if reFiller.MatchString(label) {
				hard = appendUniq(hard, reason)
			} else {
				hard = appendUniq(hard, formatPoint(label, reason))
			}
			if len(hard) >= 2 {
				break
			}
		}
	}
	for _, p := range cands {
		if reFiller.MatchString(p.Title) {
			continue
		}
		blob := p.Title + "。" + p.Teach
		if reFocusCue.MatchString(blob) {
			focus = appendUniq(focus, strings.TrimSpace(p.Title))
			if len(focus) >= 2 {
				break
			}
		}
	}
	if len(focus) == 0 {
		if p, ok := pickCore(cands); ok {
			focus = []string{strings.TrimSpace(p.Title)}
		}
	}
	return focus, hard
}

func hardReason(p page) string {
	blob := p.Title + "。" + p.Teach
	if !reHardCue.MatchString(blob) {
		return ""
	}
	for _, sent := range splitSentences(p.Teach) {
		if reHardCue.MatchString(sent) {
			return clipRunes(strings.TrimSpace(sent), 42)
		}
	}
	if reHardCue.MatchString(p.Title) {
		return ""
	}
	return clipRunes(strings.TrimSpace(p.Teach), 42)
}

func formatPoint(title, reason string) string {
	title = strings.TrimSpace(title)
	reason = strings.TrimSpace(reason)
	if reason == "" || reason == title {
		return title
	}
	return title + "：" + reason
}

func pickCore(cands []page) (page, bool) {
	var rest []page
	for _, p := range cands {
		if reFiller.MatchString(p.Title) {
			continue
		}
		if reFocusCue.MatchString(p.Title) {
			return p, true
		}
		rest = append(rest, p)
	}
	if len(rest) > 0 {
		return rest[0], true
	}
	if len(cands) > 0 {
		return cands[0], true
	}
	return page{}, false
}

func splitSentences(s string) []string {
	s = strings.NewReplacer("。", "。\n", "！", "！\n", "？", "？\n", ";", "\n", "；", "\n").Replace(s)
	var out []string
	for _, part := range strings.Split(s, "\n") {
		if t := strings.TrimSpace(part); t != "" {
			out = append(out, t)
		}
	}
	return out
}

func clipRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

func appendUniq(dst []string, v string) []string {
	v = strings.TrimSpace(v)
	if v == "" {
		return dst
	}
	for _, s := range dst {
		if s == v {
			return dst
		}
	}
	return append(dst, v)
}

func methods(slides []slide) []string {
	if len(slides) > 0 {
		return []string{"讲授法", "演示法"}
	}
	return []string{"讲授法"}
}

func stages(pages []page) []Stage {
	var groups [][]page
	for _, p := range pages {
		if p.Type == "SECTION_HEADER" && strings.TrimSpace(p.Teach) == "" {
			continue
		}
		name := classify(p, len(pages))
		if len(groups) == 0 || classify(groups[len(groups)-1][0], len(pages)) != name {
			groups = append(groups, []page{p})
			continue
		}
		groups[len(groups)-1] = append(groups[len(groups)-1], p)
	}
	out := make([]Stage, 0, len(groups))
	for _, g := range groups {
		out = append(out, stageFromPages(g, len(pages)))
	}
	return out
}

func stageFromPages(g []page, n int) Stage {
	first := g[0]
	name := classify(first, n)
	st := Stage{
		Name:    name,
		Pages:   pageRange(g),
		Title:   first.Title,
		Student: studentOf(name, joinTeach(g)),
		Intent:  intentOf(name),
	}
	if len(g) == 1 {
		st.Teacher = strings.TrimSpace(first.Teach)
		return st
	}
	var b strings.Builder
	for i, p := range g {
		if i > 0 {
			b.WriteString("\n\n")
		}
		if t := strings.TrimSpace(p.Title); t != "" && !strings.HasPrefix(t, "第 ") {
			fmt.Fprintf(&b, "【%s】\n", t)
		}
		b.WriteString(strings.TrimSpace(p.Teach))
	}
	st.Teacher = b.String()
	if last := strings.TrimSpace(g[len(g)-1].Title); last != "" && last != first.Title {
		st.Title = first.Title + "等"
	}
	return st
}

func pageRange(g []page) string {
	if len(g) == 0 {
		return ""
	}
	a, b := g[0].Order, g[len(g)-1].Order
	if a == b {
		return fmt.Sprintf("%d", a)
	}
	return fmt.Sprintf("%d–%d", a, b)
}

func joinTeach(g []page) string {
	var b strings.Builder
	for _, p := range g {
		b.WriteString(p.Teach)
		b.WriteByte('\n')
	}
	return b.String()
}

func classify(p page, n int) string {
	switch p.Type {
	case "COVER":
		return "导入"
	case "BACK_COVER":
		return "小结"
	case "SECTION_HEADER":
		return "新授"
	}
	if p.Type == "" || p.Type == "CONTENT" || p.Type == "QUOTE" {
		if n == 1 {
			return "导入"
		}
		if p.Order == 1 {
			return "导入"
		}
		if reSummary.MatchString(p.Title) {
			return "小结"
		}
	}
	return "新授"
}

func studentOf(name, teach string) string {
	if m := reStudentCue.FindString(teach); m != "" {
		return m
	}
	switch name {
	case "导入":
		return "观看课件，明确本课课题"
	case "小结":
		return "回顾本课内容"
	default:
		return "聆听讲解，记录要点"
	}
}

func intentOf(name string) string {
	switch name {
	case "导入":
		return "出示课题，集中注意"
	case "小结":
		return "回顾要点，收束本课"
	default:
		return "围绕本环节要点展开讲解"
	}
}

func Markdown(p *Plan) string { return renderMarkdown(p) }

// FromTeaching 用课文侧 LLM 产出写成教案，不依赖 PPT 讲稿。
func FromTeaching(title string, raw []byte) (*Plan, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		title = "本课"
	}
	p := &Plan{Title: title, Methods: []string{"讲授法"}}
	if err := Overlay(p, raw); err != nil {
		return nil, err
	}
	if len(p.Process) == 0 {
		return nil, fmt.Errorf("lessonplan: overlay: empty 教学过程")
	}
	if strings.TrimSpace(p.Script) == "" {
		return nil, fmt.Errorf("lessonplan: overlay: empty 讲授稿")
	}
	return p, nil
}

// Overlay 用 LLM 产出覆盖教学目标/重点/难点；若带教学过程/讲授稿一并覆盖。
func Overlay(p *Plan, raw []byte) error {
	if p == nil {
		return ErrEmpty
	}
	var doc struct {
		Goals   []string `json:"教学目标"`
		Focus   []string `json:"教学重点"`
		Hard    []string `json:"教学难点"`
		Methods []string `json:"教学方法"`
		Process []Stage  `json:"教学过程"`
		Script  string   `json:"讲授稿"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return fmt.Errorf("lessonplan: overlay: %w", err)
	}
	goals := trimAll(doc.Goals)
	focus := trimAll(doc.Focus)
	if len(goals) == 0 {
		return fmt.Errorf("lessonplan: overlay: empty 教学目标")
	}
	if len(focus) == 0 {
		return fmt.Errorf("lessonplan: overlay: empty 教学重点")
	}
	p.Goals = goals
	p.Focus = focus
	p.Hard = trimAll(doc.Hard)
	if m := trimAll(doc.Methods); len(m) > 0 {
		p.Methods = m
	}
	if proc := trimStages(doc.Process); len(proc) > 0 {
		p.Process = proc
	}
	if s := strings.TrimSpace(doc.Script); s != "" {
		p.Script = s
	}
	return nil
}

func trimStages(in []Stage) []Stage {
	var out []Stage
	for _, s := range in {
		s.Name = strings.TrimSpace(s.Name)
		s.Teacher = strings.TrimSpace(s.Teacher)
		s.Student = strings.TrimSpace(s.Student)
		s.Intent = strings.TrimSpace(s.Intent)
		s.Title = strings.TrimSpace(s.Title)
		s.Pages = strings.TrimSpace(s.Pages)
		if s.Name == "" || s.Teacher == "" {
			continue
		}
		out = append(out, s)
	}
	return out
}

func trimAll(ss []string) []string {
	var out []string
	for _, s := range ss {
		if t := strings.TrimSpace(s); t != "" {
			out = append(out, t)
		}
	}
	return out
}

func parseNotes(raw []byte) ([]string, error) {
	if len(strings.TrimSpace(string(raw))) == 0 {
		return nil, ErrEmpty
	}
	var arr []json.RawMessage
	if err := json.Unmarshal(raw, &arr); err == nil {
		if len(arr) == 0 {
			return nil, ErrEmpty
		}
	} else {
		var wrap struct {
			Pages []json.RawMessage `json:"pages"`
		}
		if err := json.Unmarshal(raw, &wrap); err != nil {
			return nil, fmt.Errorf("lessonplan: notes: %w", err)
		}
		arr = wrap.Pages
		if len(arr) == 0 {
			return nil, ErrEmpty
		}
	}
	out := make([]string, 0, len(arr))
	for _, item := range arr {
		out = append(out, noteText(item))
	}
	return out, nil
}

func noteText(raw json.RawMessage) string {
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		return strings.TrimSpace(string(raw))
	}
	for _, key := range []string{"notes", "note", "讲授", "text"} {
		if s, ok := obj[key].(string); ok && strings.TrimSpace(s) != "" {
			return strings.TrimSpace(s)
		}
	}
	return ""
}

func parseSlides(raw []byte) []slide {
	if len(strings.TrimSpace(string(raw))) == 0 {
		return nil
	}
	var wrap struct {
		Slides []slide `json:"slides"`
	}
	if err := json.Unmarshal(raw, &wrap); err != nil {
		return nil
	}
	return wrap.Slides
}

func renderMarkdown(p *Plan) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# %s 教案\n", p.Title)
	writeList(&b, "一、教学目标", p.Goals)
	writeFocusHard(&b, p)
	writeList(&b, "三、教学方法", p.Methods)
	fmt.Fprintf(&b, "\n## 四、教学过程\n")
	for i, s := range p.Process {
		head := s.Name
		if s.Title != "" {
			head += "（第 " + s.Pages + " 页 · " + s.Title + "）"
		} else if s.Pages != "" {
			head += "（第 " + s.Pages + " 页）"
		}
		fmt.Fprintf(&b, "\n### %s%s\n", circleNum(i), head)
		if strings.TrimSpace(s.Teacher) != "" {
			fmt.Fprintf(&b, "**教师活动：** %s\n", s.Teacher)
		}
		if strings.TrimSpace(s.Student) != "" {
			fmt.Fprintf(&b, "**学生活动：** %s\n", s.Student)
		}
		if strings.TrimSpace(s.Intent) != "" {
			fmt.Fprintf(&b, "**设计意图：** %s\n", s.Intent)
		}
	}
	if s := strings.TrimSpace(p.Script); s != "" {
		fmt.Fprintf(&b, "\n## 五、教学讲稿\n\n%s\n", s)
	}
	if len(p.Drift) > 0 {
		fmt.Fprintf(&b, "\n## 课件对照\n")
		for _, it := range p.Drift {
			fmt.Fprintf(&b, "\n- %s\n", it)
		}
	}
	return b.String()
}

func writeFocusHard(b *strings.Builder, p *Plan) {
	fmt.Fprintf(b, "\n## 二、教学重难点\n")
	fmt.Fprintf(b, "\n**重点**\n")
	if len(p.Focus) == 0 {
		fmt.Fprintf(b, "\n- （无）\n")
	} else {
		for _, it := range p.Focus {
			fmt.Fprintf(b, "\n- %s\n", it)
		}
	}
	fmt.Fprintf(b, "\n**难点**\n")
	if len(p.Hard) == 0 {
		fmt.Fprintf(b, "\n- （无）\n")
	} else {
		for _, it := range p.Hard {
			fmt.Fprintf(b, "\n- %s\n", it)
		}
	}
}

func writeList(b *strings.Builder, heading string, items []string) {
	fmt.Fprintf(b, "\n## %s\n", heading)
	if len(items) == 0 {
		fmt.Fprintf(b, "\n（无）\n")
		return
	}
	for _, it := range items {
		fmt.Fprintf(b, "\n- %s\n", it)
	}
}

func circleNum(i int) string {
	names := []string{"（一）", "（二）", "（三）", "（四）", "（五）", "（六）", "（七）", "（八）", "（九）", "（十）"}
	if i >= 0 && i < len(names) {
		return names[i]
	}
	return fmt.Sprintf("（%d）", i+1)
}
