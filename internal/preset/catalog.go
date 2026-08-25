package preset

var catalog = map[string]Preset{
	DigitalLesson: {
		ID: DigitalLesson,
		Copy: Copy{
			ListTitle:        "我的课程",
			ListHint:         "一个项目是一套课程。每一课各自上传材料、各自出套件。",
			CreateCTA:        "新建课程",
			CreateTitle:      "新建课程",
			TitleLabel:       "课程名",
			TitleHint:        "例如：高等数学",
			LessonCTA:        "新建一课",
			LessonTitle:      "新建一课",
			LessonTitleLabel: "课名",
			LessonTitleHint:  "例如：第 3 章 导数",
			EmptyLessons:     "这套课程还没有课。点右上角建第一课。",
			MaterialsHint:    "每课最多 5 份。支持 PDF、Word（.docx）、Markdown、纯文本。",
			SubmitCTA:        "做课件",
			ConfirmCTA:       "",
			ConfirmHint:      "",
			EmptyList:        "还没有课程。点右上角建第一套。",
			ArtifactLabels: map[string]string{
				"outline": "课件大纲",
				"ppt":     "PPT",
				"script":  "讲稿",
				"plan":    "教案",
			},
		},
		Artifacts: []string{"outline", "ppt", "script"},
		Steps: []Step{
			{Capability: "ppt", Platform: "pptcreator", Emits: []string{"ppt", "script", "outline"}},
		},
	},
}
