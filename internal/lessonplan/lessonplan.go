// Package lessonplan 把讲稿 notes（及可选课件大纲）整理成教案栏目。
// 只做形态加工，不从章材料另写课程设计（设计 §2.4 / PLAN V5）。
package lessonplan

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

var ErrEmpty = errors.New("lessonplan: notes empty")

// Plan 是教案栏目结构。课题来自课名；栏目按讲稿页展开。
type Plan struct {
	Title   string   `json:"课题"`
	Columns []Column `json:"栏目"`
}

// Column 是一页对应的教案行。
type Column struct {
	Page  int    `json:"页"`
	Title string `json:"标题"`
	Type  string `json:"类型,omitempty"`
	Teach string `json:"讲授"`
}

type slide struct {
	Order int    `json:"order"`
	Type  string `json:"type"`
	Title string `json:"title"`
}

// Reshape 用大纲页序套讲稿 notes，产出教案 JSON 与 Markdown。
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
	cols := make([]Column, 0, n)
	for i := 0; i < n; i++ {
		col := Column{Page: i + 1, Title: fmt.Sprintf("第 %d 页", i+1)}
		if i < len(slides) {
			if slides[i].Order > 0 {
				col.Page = slides[i].Order
			}
			if t := strings.TrimSpace(slides[i].Title); t != "" {
				col.Title = t
			}
			col.Type = strings.TrimSpace(slides[i].Type)
		}
		if i < len(teaches) {
			col.Teach = teaches[i]
		}
		cols = append(cols, col)
	}
	if !hasTeach(cols) {
		return nil, "", ErrEmpty
	}
	title := strings.TrimSpace(lessonTitle)
	if title == "" {
		title = cols[0].Title
	}
	p := &Plan{Title: title, Columns: cols}
	return p, renderMarkdown(p), nil
}

func hasTeach(cols []Column) bool {
	for _, c := range cols {
		if strings.TrimSpace(c.Teach) != "" {
			return true
		}
	}
	return false
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
	fmt.Fprintf(&b, "# %s\n\n## 教学过程\n", p.Title)
	for _, c := range p.Columns {
		fmt.Fprintf(&b, "\n### 第 %d 页　%s\n", c.Page, c.Title)
		if c.Type != "" {
			fmt.Fprintf(&b, "类型：%s\n\n", c.Type)
		}
		if strings.TrimSpace(c.Teach) != "" {
			fmt.Fprintf(&b, "讲授要点：%s\n", c.Teach)
		}
	}
	return b.String()
}
