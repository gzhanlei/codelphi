// Package preset 是运行时商品目录：拓扑 + 工作台文案。
// 卖的是包，不是 org.industry。P0 只内置 digital_lesson。
package preset

import (
	"encoding/json"
	"errors"
	"fmt"
)

const DigitalLesson = "digital_lesson"

var (
	ErrUnknown     = errors.New("preset: unknown")
	ErrUnspecified = errors.New("preset: unspecified")
	ErrForbidden   = errors.New("preset: forbidden")
)

type Copy struct {
	ListTitle      string            `json:"list_title"`
	ListHint       string            `json:"list_hint"`
	CreateCTA      string            `json:"create_cta"`
	CreateTitle    string            `json:"create_title"`
	TitleLabel     string            `json:"title_label"`
	TitleHint      string            `json:"title_hint"`
	SubmitCTA      string            `json:"submit_cta"`
	ConfirmCTA     string            `json:"confirm_cta"`
	ConfirmHint    string            `json:"confirm_hint"`
	EmptyList      string            `json:"empty_list"`
	ArtifactLabels map[string]string `json:"artifact_labels"`
}

type Step struct {
	Capability string   `json:"capability"`
	Platform   string   `json:"platform"` // llm | pptcreator
	GateAfter  bool     `json:"gate_after,omitempty"`
	Emits      []string `json:"emits"`
}

type Preset struct {
	ID        string   `json:"id"`
	Copy      Copy     `json:"copy"`
	Artifacts []string `json:"artifacts"`
	Steps     []Step   `json:"steps"`
}

func Lookup(id string) (Preset, error) {
	p, ok := catalog[id]
	if !ok {
		return Preset{}, fmt.Errorf("%w: %s", ErrUnknown, id)
	}
	return p, nil
}

func MustLookup(id string) Preset {
	p, err := Lookup(id)
	if err != nil {
		panic(err)
	}
	return p
}

func (p Preset) Validate() error {
	if p.ID == "" || len(p.Steps) == 0 || len(p.Artifacts) == 0 {
		return fmt.Errorf("preset %s: empty topology", p.ID)
	}
	want := map[string]bool{}
	for _, k := range p.Artifacts {
		want[k] = true
		if p.Copy.ArtifactLabels[k] == "" {
			return fmt.Errorf("preset %s: missing label for %s", p.ID, k)
		}
	}
	got := map[string]bool{}
	for _, s := range p.Steps {
		if s.Capability == "" || s.Platform == "" || len(s.Emits) == 0 {
			return fmt.Errorf("preset %s: incomplete step %q", p.ID, s.Capability)
		}
		for _, e := range s.Emits {
			got[e] = true
			if !want[e] {
				return fmt.Errorf("preset %s: step emits undeclared kind %s", p.ID, e)
			}
		}
	}
	for k := range want {
		if !got[k] {
			return fmt.Errorf("preset %s: artifact %s never emitted", p.ID, k)
		}
	}
	return nil
}

// Entitled 读 License.presets JSON 数组。NULL / 空 / 解析失败 → 仅 digital_lesson（兼容未迁移行）。
func Entitled(raw json.RawMessage) []string {
	if len(raw) == 0 || string(raw) == "null" {
		return []string{DigitalLesson}
	}
	var ids []string
	if err := json.Unmarshal(raw, &ids); err != nil || len(ids) == 0 {
		return []string{DigitalLesson}
	}
	return ids
}

// UnionEntitled 合并多个 License 的包（先到期者优先顺序下的并集，去重保序）。
func UnionEntitled(raws []json.RawMessage) []string {
	seen := map[string]bool{}
	var out []string
	if len(raws) == 0 {
		return []string{DigitalLesson}
	}
	for _, raw := range raws {
		for _, id := range Entitled(raw) {
			if seen[id] {
				continue
			}
			seen[id] = true
			out = append(out, id)
		}
	}
	if len(out) == 0 {
		return []string{DigitalLesson}
	}
	return out
}

func ResolveCreate(requested string, entitled []string) (string, error) {
	if len(entitled) == 0 {
		entitled = []string{DigitalLesson}
	}
	allow := map[string]bool{}
	for _, id := range entitled {
		allow[id] = true
	}
	if requested == "" {
		if len(entitled) == 1 {
			return entitled[0], nil
		}
		return "", ErrUnspecified
	}
	if !allow[requested] {
		return "", fmt.Errorf("%w: %s", ErrForbidden, requested)
	}
	if _, err := Lookup(requested); err != nil {
		return "", err
	}
	return requested, nil
}

func Contains(entitled []string, id string) bool {
	for _, e := range entitled {
		if e == id {
			return true
		}
	}
	return false
}

// List 只返回目录里存在的包（授权了尚未上线的 id 会被跳过）。
func List(ids []string) []Preset {
	var out []Preset
	for _, id := range ids {
		p, err := Lookup(id)
		if err != nil {
			continue
		}
		out = append(out, p)
	}
	return out
}
