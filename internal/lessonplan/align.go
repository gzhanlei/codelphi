package lessonplan

import (
	"fmt"
	"strings"
	"unicode"
)

// Issue 是课件大纲相对教案的一处对不上。
type Issue struct {
	Code    string
	Message string
}

func (i Issue) String() string {
	if i.Message != "" {
		return i.Message
	}
	return i.Code
}

// CheckDeck 对照教案看课件大纲（及讲稿 notes）是否覆盖教学重点。没有课件时不报错。
func CheckDeck(p *Plan, outline, notes []byte) []Issue {
	if p == nil {
		return []Issue{{Code: "no_plan", Message: "没有教案，无法对照课件"}}
	}
	slides := parseSlides(outline)
	if len(slides) == 0 {
		return nil
	}
	blob := slideBlob(slides) + "\n" + string(notes)
	var issues []Issue
	for _, f := range p.Focus {
		if !covered(f, blob, slides) {
			issues = append(issues, Issue{
				Code:    "uncovered_focus",
				Message: "课件未覆盖教学重点：" + f,
			})
		}
	}
	hasCover, hasContent, hasBack := false, false, false
	for _, s := range slides {
		switch strings.ToUpper(strings.TrimSpace(s.Type)) {
		case "COVER":
			hasCover = true
		case "CONTENT", "SECTION_HEADER", "QUOTE":
			hasContent = true
		case "BACK_COVER":
			hasBack = true
		}
	}
	for _, st := range p.Process {
		switch st.Name {
		case "导入":
			if !hasCover && !hasContent {
				issues = append(issues, Issue{Code: "missing_intro", Message: "教案有导入，课件没有对应页"})
			}
		case "新授":
			if !hasContent {
				issues = append(issues, Issue{Code: "missing_teach", Message: "教案有新授，课件没有内容页"})
			}
		case "小结":
			if !hasBack && !hasContent {
				issues = append(issues, Issue{Code: "missing_summary", Message: "教案有小结，课件没有收束页"})
			}
		}
	}
	return issues
}

// Critique 把对照问题收成返工意见，交给做片再生成。
func Critique(issues []Issue) string {
	if len(issues) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("课件与教案对不上，请按教案重做，不要另起一套知识结构。\n")
	for _, it := range issues {
		fmt.Fprintf(&b, "- %s\n", it.String())
	}
	return strings.TrimSpace(b.String())
}

func slideBlob(slides []slide) string {
	var b strings.Builder
	for _, s := range slides {
		b.WriteString(s.Title)
		b.WriteByte('\n')
		b.WriteString(s.Chapter)
		b.WriteByte('\n')
	}
	return b.String()
}

func covered(focus, blob string, slides []slide) bool {
	focus = strings.TrimSpace(focus)
	if focus == "" {
		return true
	}
	if strings.Contains(blob, focus) {
		return true
	}
	for _, s := range slides {
		t := strings.TrimSpace(s.Title)
		if t == "" {
			continue
		}
		if strings.Contains(focus, t) || strings.Contains(t, focus) {
			return true
		}
	}
	for _, tok := range tokens(focus) {
		if strings.Contains(blob, tok) {
			return true
		}
	}
	return false
}

func tokens(s string) []string {
	var cur strings.Builder
	var out []string
	flush := func() {
		t := strings.TrimSpace(cur.String())
		cur.Reset()
		if runes := []rune(t); len(runes) >= 2 {
			out = append(out, t)
		}
	}
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.Is(unicode.Han, r) || unicode.IsDigit(r) {
			cur.WriteRune(r)
			continue
		}
		flush()
	}
	flush()
	skip := map[string]bool{"作为": true, "理解": true, "掌握": true, "学生": true, "本课": true, "过程": true}
	var keep []string
	for _, t := range out {
		if skip[t] {
			continue
		}
		keep = append(keep, t)
	}
	return keep
}
